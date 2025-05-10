/**
 * Marketplace synchronization routes and functions
 * Handles syncing products and orders between Etsy, Shopify, and internal inventory
 * @module routes/sync
 */
const express = require('express');
const router = express.Router();
const Product = require('../models/product');
const Order = require('../models/order');
const Settings = require('../models/settings'); // Import Settings model
const { logger } = require('../utils/logger');
// Import etsyFetch and API_BASE_URL
const { getShopId, etsyFetch, API_BASE_URL } = require('../utils/etsy-helpers');
const shopifyHelpers = require('../utils/shopify-helpers');
const fs = require('fs').promises;
const path = require('path');
const { Readable } = require('stream');
// Import pipeline and readline
const { pipeline } = require('stream/promises');
const readline = require('readline');
// Import performance from perf_hooks
const { performance } = require('perf_hooks');
const Shopify = require('shopify-api-node'); // Add this import for direct Shopify client
const fsSync = require('fs'); // For createWriteStream
const { etsyRequest } = require('../utils/etsy-request-pool');
// Removing unused imports

// In-memory store for sync status with enhanced retention
const syncStatus = new Map();

// Constants for sync status management
const SYNC_STATUS_RETENTION_MS = 10 * 60 * 1000; // Keep sync status for 10 minutes

/**
 * Concurrency settings for parallel API page fetches.
 * These do NOT override the global Etsy API concurrency pool, which is always enforced.
 * Tune these for performance as needed.
 */
const PRODUCT_SYNC_CONCURRENCY = 5; // For product listing syncs
const ORDER_SYNC_CONCURRENCY = 5; // For order syncs

/**
 * Validates and processes a syncId from request parameters
 * @param {string} requestSyncId - The sync ID from request parameters
 * @param {string} marketplace - The marketplace (etsy or shopify)
 * @param {string} syncType - The type of sync (products, orders, etc.)
 * @returns {string} A validated syncId
 */
function validateSyncId(requestSyncId, marketplace, syncType) {
	if (requestSyncId) {
		// Validate existing syncId format (allow old format for backward compatibility)
		return requestSyncId;
	}

	// Generate new standardized syncId
	return `${marketplace.toLowerCase()}-${syncType.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

/**
 * Initializes sync status tracking for a new sync operation
 * @param {string} syncId - The unique ID for this sync operation
 * @param {string} marketplace - The marketplace this sync is for (etsy or shopify)
 * @param {string} syncType - The type of sync operation (products, orders, etc.)
 * @returns {Object} The initialized status object
 */
function initializeSyncStatus(syncId, marketplace, syncType) {
	const status = {
		syncId,
		marketplace,
		syncType,
		syncCount: 0,
		processedCount: 0,
		totalCount: 0,
		counts: {},
		currentPhase: `Initializing ${marketplace} ${syncType} sync`,
		removedCount: 0,
		progress: 5, // Start with 5% to show something is happening
		complete: false,
		error: null,
		startTime: Date.now(),
		lastUpdated: Date.now(),
	};

	syncStatus.set(syncId, status);
	logger.info(`Initialized sync status for ${syncId}`, { syncId, marketplace, syncType });
	return status;
}

/**
 * Updates the status of a sync operation
 * @param {string} syncId - The sync ID to update
 * @param {Object} updates - The properties to update
 * @returns {Object|null} The updated status or null if not found
 */
function updateSyncStatus(syncId, updates) {
	const status = syncStatus.get(syncId);
	if (!status) {
		logger.warn(`Attempted to update non-existent sync status: ${syncId}`);
		return null;
	}

	Object.assign(status, updates, { lastUpdated: Date.now() });
	syncStatus.set(syncId, status);
	return status;
}

router.get('/secretroute', async (req, res) => {
	// This is a secret route for testing purposes only
	// In a real application, you would not expose this endpoint like this
	initializeSyncStatus(req.query.syncId, 'dummy', 'data');

	const status = updateSyncStatus(req.query.syncId, {
		syncCount: 31,
		processedCount: 30,
		totalCount: '25',
		progress: 69,
		currentPhase: 'Testing modal',
		counts: '69?',
	});
	res.json(status);
});

/**
 * Marks a sync operation as complete
 * @param {string} syncId - The sync ID to complete
 * @param {Object} finalUpdates - Final updates to apply before marking as complete
 * @param {Error|null} error - Optional error if the sync failed
 */
function completeSyncStatus(syncId, finalUpdates = {}, error = null) {
	const status = syncStatus.get(syncId);
	if (!status) {
		logger.warn(`Attempted to complete non-existent sync status: ${syncId}`);
		return;
	}

	const updates = {
		...finalUpdates,
		complete: true,
		progress: 100,
		currentPhase: error ? 'Failed' : 'Complete',
		endTime: Date.now(),
		duration: Date.now() - status.startTime,
	};

	if (error) {
		updates.error = typeof error === 'string' ? error : error.message;
		logger.error(`Sync ${syncId} completed with error: ${updates.error}`);
	} else {
		logger.info(`Sync ${syncId} completed successfully in ${updates.duration}ms`);
	}

	Object.assign(status, updates);
	syncStatus.set(syncId, status);

	// Schedule status cleanup after retention period
	setTimeout(() => {
		if (syncStatus.has(syncId)) {
			logger.debug(`Cleaning up sync status for ${syncId} after retention period`);
			syncStatus.delete(syncId);
		}
	}, SYNC_STATUS_RETENTION_MS);
}

/**
 * Main sync dashboard route
 * Displays synchronization statistics and last sync times
 * @route GET /sync
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void} Renders the sync dashboard view with statistics
 */
router.get('/', async (req, res) => {
	try {
		// Fetch last sync times from settings
		const etsySyncTime = await Settings.getSetting('lastEtsyOrderSync');
		const shopifySyncTime = await Settings.getSetting('lastShopifyOrderSync');
		const etsyProductSyncTime = await Settings.getSetting('lastEtsyProductSync');
		const shopifyProductSyncTime = await Settings.getSetting('lastShopifyProductSync');

		const [
			totalProducts,
			productsWithEtsy,
			productsWithShopify,
			lastEtsyProductSyncDoc, // Renamed for clarity
			lastShopifyProductSyncDoc, // Renamed for clarity
			lastEtsyOrderSyncDoc, // Added for Etsy order sync time
			lastShopifyOrderSyncDoc, // Added for Shopify order sync time
		] = await Promise.all([
			Product.countDocuments(),
			Product.countDocuments({ 'etsy_data.listing_id': { $exists: true } }),
			Product.countDocuments({ 'shopify_data.product_id': { $exists: true } }),
			// Find latest product sync time (Etsy)
			Product.findOne({ 'etsy_data.last_synced': { $exists: true } })
				.sort({ 'etsy_data.last_synced': -1 })
				.select('etsy_data.last_synced')
				.lean(), // Use lean for performance
			// Find latest product sync time (Shopify)
			Product.findOne({ 'shopify_data.last_synced': { $exists: true } })
				.sort({ 'shopify_data.last_synced': -1 })
				.select('shopify_data.last_synced')
				.lean(), // Use lean for performance
			// Find latest order sync time (Etsy) - using updatedAt
			Order.findOne({ marketplace: 'etsy', updatedAt: { $exists: true } })
				.sort({ updatedAt: -1 })
				.select('updatedAt')
				.lean(),
			// Find latest order sync time (Shopify) - using updatedAt
			Order.findOne({ marketplace: 'shopify', updatedAt: { $exists: true } })
				.sort({ updatedAt: -1 })
				.select('updatedAt')
				.lean(),
			// Note: lastInventorySync source is still TBD
		]);

		res.render('sync', {
			stats: {
				totalProducts,
				productsWithEtsy,
				productsWithShopify,
				// Extract dates safely
				lastEtsySync: lastEtsyProductSyncDoc?.etsy_data?.last_synced,
				lastShopifySync: lastShopifyProductSyncDoc?.shopify_data?.last_synced,
				lastEtsyOrderSync: lastEtsyOrderSyncDoc?.updatedAt,
				lastShopifyOrderSync: lastShopifyOrderSyncDoc?.updatedAt,
				lastInventorySync: null, // Placeholder - still needs data source
			},
			activePage: 'sync', // Add activePage here
			// Pass sync times to the template, formatting them
			lastEtsyOrderSync: etsySyncTime ? new Date(etsySyncTime).toLocaleString() : 'N/A',
			lastShopifyOrderSync: shopifySyncTime
				? new Date(shopifySyncTime).toLocaleString()
				: 'N/A',
			lastEtsyProductSync: etsyProductSyncTime
				? new Date(etsyProductSyncTime).toLocaleString()
				: 'N/A',
			lastShopifyProductSync: shopifyProductSyncTime
				? new Date(shopifyProductSyncTime).toLocaleString()
				: 'N/A',
		});
	} catch (error) {
		logger.error('Error fetching sync dashboard data:', error); // Log the error
		req.flash('error', 'Error loading sync dashboard data');
		// Render page with empty stats on error to avoid breaking layout
		res.render('sync', {
			stats: {
				lastEtsySync: null,
				lastShopifySync: null,
				lastEtsyOrderSync: null,
				lastShopifyOrderSync: null,
				lastInventorySync: null,
			},
			activePage: 'sync',
		});
	}
});

/**
 * Helper function to fetch all Etsy listings in bulk from all listing states
 * Uses the Etsy API to fetch active, draft, expired, inactive, and sold_out listings
 * @param {string} shop_id - The Etsy shop ID to fetch listings for
 * @param {string} syncId - Optional sync ID for tracking progress
 * @returns {Promise<Object>} Object containing all fetched listings and counts by status
 */
async function fetchAllListings(shop_id, syncId) {
	const startTime = performance.now();
	const listingCounts = {
		active: 0,
		draft: 0,
		expired: 0,
		inactive: 0,
		sold_out: 0,
	};
	const allListings = [];
	// Note: CONCURRENCY here controls how many parallel jobs (e.g., pages) this sync logic will attempt to process at once.
	// The global Etsy API concurrency limit is enforced by etsy-request-pool.js and will always keep us within Etsy's rate limits.
	// You can tune this value for performance, but the global pool is the final safeguard.

	// Update status if syncId is provided
	const updateStatus = (progress, currentPhase = '') => {
		if (syncId) {
			const status = syncStatus.get(syncId);
			if (status) {
				status.counts = { ...listingCounts };
				status.progress = progress;
				// Calculate total items processed so far
				status.syncCount = Object.values(listingCounts).reduce(
					(sum, count) => sum + count,
					0
				);
				if (currentPhase) {
					status.currentPhase = currentPhase;
				}
				syncStatus.set(syncId, status);
				console.log(`Updated status for ${syncId}:`, status);
			}
		}
	};

	// Fetch active listings (includes draft and sold out)
	const limit = 100;
	const tokenData = JSON.parse(process.env.TOKEN_DATA);

	// Get selected shipping profiles to filter by
	const selectedShippingProfiles = process.env.SYNC_SHIPPING_PROFILES
		? JSON.parse(process.env.SYNC_SHIPPING_PROFILES)
		: [];

	const hasShippingProfileFilter = selectedShippingProfiles.length > 0;
	logger.info('Fetching listings with shipping profile filter', {
		filterEnabled: hasShippingProfileFilter,
		selectedProfiles: selectedShippingProfiles,
	});

	var headers = new Headers();

	const states = ['active', 'draft', 'expired', 'inactive', 'sold_out'];

	headers.append('x-api-key', process.env.ETSY_API_KEY);
	headers.append('Authorization', `Bearer ${tokenData.access_token}`);

	logger.info('Fetching all listings with complete data...');
	updateStatus(10); // Initial status update

	// Parallelize per state
	for (const state of states) {
		let offset = 0;
		let urlencoded = new URLSearchParams();
		urlencoded.append('state', state);
		urlencoded.append('limit', limit);
		urlencoded.append('offset', offset);
		urlencoded.append('includes', 'Shipping,Images,Shop,User,Translations,Inventory,Videos');
		let requestOptions = {
			method: 'GET',
			headers: headers,
			redirect: 'follow',
		};
		const fetchUrl = `https://openapi.etsy.com/v3/application/shops/${shop_id}/listings?${urlencoded.toString()}`;
		const firstResp = await etsyRequest(() => etsyFetch(fetchUrl, requestOptions), {
			endpoint: '/listings',
			method: 'GET',
			state,
			offset: 0,
			syncId,
		});
		if (!firstResp.ok) {
			const errorText = await firstResp.text();
			logger.error('Error fetching listings:', {
				status: firstResp.status,
				statusText: firstResp.statusText,
				details: errorText,
			});
			throw new Error(
				`Failed to fetch listings: ${firstResp.status} ${firstResp.statusText}`
			);
		}
		const firstData = await firstResp.json();
		const firstListings = firstData.results || [];
		// Filter listings by shipping profile if filter is enabled
		const filteredFirstListings = hasShippingProfileFilter
			? firstListings.filter(listing =>
					selectedShippingProfiles.includes(listing.shipping_profile_id?.toString())
				)
			: firstListings;
		listingCounts[state] = filteredFirstListings.length;
		allListings.push(...filteredFirstListings);
		const totalCount =
			typeof firstData.count === 'number' && isFinite(firstData.count) && firstData.count > 0
				? firstData.count
				: firstListings.length;
		const totalPages = Math.ceil(totalCount / limit);
		if (totalPages > 1) {
			// Prepare offsets for remaining pages
			const offsets = [];
			for (let i = 1; i < totalPages; i++) {
				offsets.push(i * limit);
			}
			async function fetchPage(offset) {
				let retries = 0;
				while (retries < 5) {
					urlencoded.set('offset', offset);
					urlencoded.set('state', state);
					const pageUrl = `https://openapi.etsy.com/v3/application/shops/${shop_id}/listings?${urlencoded.toString()}`;
					try {
						const resp = await etsyRequest(() => etsyFetch(pageUrl, requestOptions), {
							endpoint: '/listings',
							method: 'GET',
							state,
							offset,
							syncId,
						});
						if (!resp.ok) {
							const errorText = await resp.text();
							logger.error('Error fetching listings:', {
								status: resp.status,
								error: errorText,
							});
							throw new Error(
								`Failed to fetch listings: ${resp.status} ${resp.statusText}`
							);
						}
						const data = await resp.json();
						const listings = data.results || [];
						return hasShippingProfileFilter
							? listings.filter(listing =>
									selectedShippingProfiles.includes(
										listing.shipping_profile_id?.toString()
									)
								)
							: listings;
					} catch (err) {
						logger.error('Error fetching listings page', {
							offset,
							state,
							error: err.message,
						});
						await new Promise(r => setTimeout(r, 1000 * Math.pow(2, retries)));
						retries++;
					}
				}
				logger.error('Failed to fetch listings after retries', { offset, state });
				return [];
			}
			let idx = 0;
			const results = [];
			async function worker() {
				while (idx < offsets.length) {
					const myIdx = idx++;
					const offset = offsets[myIdx];
					const res = await fetchPage(offset);
					listingCounts[state] += res.length;
					results.push(...res);
				}
			}
			await Promise.all(
				Array(PRODUCT_SYNC_CONCURRENCY)
					.fill(0)
					.map(() => worker())
			);
			allListings.push(...results);
		}
		updateStatus(10 + Math.round((states.indexOf(state) / states.length) * 70));
	}
	logger.info('Finished fetching all listings', { counts: listingCounts });
	updateStatus(30); // Final update after all listings are fetched
	const endTime = performance.now();
	logger.info(`[Perf] fetchAllListings took ${(endTime - startTime).toFixed(2)}ms`, { syncId });
	return { listings: allListings, counts: listingCounts };
}

/**
 * Helper function to clean up products that don't match selected shipping profiles
 * Removes products with shipping profiles not in the configured allowlist
 * @returns {Promise<Object>} Result object with count of deleted products or abort information
 */
async function removeProductsWithUnselectedShippingProfiles() {
	const startTime = performance.now();
	try {
		// Get selected shipping profiles from environment variables
		const selectedShippingProfiles = process.env.SYNC_SHIPPING_PROFILES
			? JSON.parse(process.env.SYNC_SHIPPING_PROFILES)
			: [];

		logger.info('Cleaning up products with non-matching shipping profiles', {
			selectedProfiles: selectedShippingProfiles,
		});

		// If no shipping profiles are selected, don't delete anything
		if (!selectedShippingProfiles || selectedShippingProfiles.length === 0) {
			logger.info('No shipping profiles selected, skipping cleanup');
			return { deletedCount: 0 };
		}

		// Safety check: If we're about to delete more than 50% of products, abort
		const totalEtsyProducts = await Product.countDocuments({
			'etsy_data.listing_id': { $exists: true },
		});

		// Convert all selected profile IDs to strings explicitly to ensure consistency
		const selectedProfilesAsStrings = selectedShippingProfiles.map(id => String(id));

		// Simplified query - no type conversion needed since shipping_profile_id is already a String
		const query = {
			'etsy_data.listing_id': { $exists: true },
			$or: [
				{ 'etsy_data.shipping_profile_id': { $exists: false } },
				{ 'etsy_data.shipping_profile_id': null },
				{ 'etsy_data.shipping_profile_id': '' },
				{
					'etsy_data.shipping_profile_id': {
						$exists: true,
						$nin: selectedProfilesAsStrings,
					},
				},
			],
		};

		const queryStartTime = performance.now();
		const productsToDelete = await Product.countDocuments(query);
		const queryEndTime = performance.now();
		logger.info(
			`[Perf] removeProductsWithUnselectedShippingProfiles count query took ${(queryEndTime - queryStartTime).toFixed(2)}ms`
		);

		logger.info('Products cleanup assessment', {
			totalEtsyProducts,
			productsToDelete,
			percentageToDelete:
				totalEtsyProducts > 0
					? ((productsToDelete / totalEtsyProducts) * 100).toFixed(2) + '%'
					: '0%',
		});

		// Safety check
		if (
			productsToDelete > totalEtsyProducts * 0.5 ||
			(totalEtsyProducts > 0 && productsToDelete === totalEtsyProducts)
		) {
			logger.warn(
				`Safety check triggered: Would remove ${productsToDelete} out of ${totalEtsyProducts} products. Skipping automated cleanup.`
			);
			return {
				deletedCount: 0,
				aborted: true,
				reason: 'Safety check triggered - too many products would be deleted',
			};
		}

		const deleteStartTime = performance.now();
		// Direct approach: execute the delete operation with the same query
		const result = await Product.deleteMany(query);
		const deleteEndTime = performance.now();
		logger.info(
			`[Perf] removeProductsWithUnselectedShippingProfiles deleteMany took ${(deleteEndTime - deleteStartTime).toFixed(2)}ms`,
			{ deletedCount: result.deletedCount }
		);

		const endTime = performance.now();
		logger.info(
			`[Perf] removeProductsWithUnselectedShippingProfiles total took ${(endTime - startTime).toFixed(2)}ms`,
			{ deletedCount: result.deletedCount }
		);
		return result;
	} catch (error) {
		logger.error('Error removing products with unselected shipping profiles:', {
			error: error.message,
		});
		throw error;
	}
}

// Sync Etsy products
/**
 * Route to initiate an Etsy product synchronization
 * Starts the sync process in the background and returns immediately
 *
 * @route GET /sync/sync-etsy
 * @param {string} [req.query.syncId] - Optional sync ID for tracking progress
 * @returns {Object} JSON response with success status and syncId or redirects to sync page
 */
router.get('/sync-etsy', async (req, res) => {
	try {
		// Get the sync ID from the query parameter
		const syncId = validateSyncId(req.query.syncId, 'etsy', 'products');
		console.log(`Starting Etsy sync with syncId: ${syncId}`);

		// Initialize sync status
		initializeSyncStatus(syncId, 'etsy', 'products');

		// Start the sync process without waiting for it to complete
		syncEtsyProducts(syncId, req).catch(error => {
			logger.error('Error in background Etsy sync:', { error: error.message });

			// Update sync status with error
			updateSyncStatus(syncId, { complete: true, error: error.message });
		});

		// If the request is from fetch (Ajax), send a JSON response
		// Otherwise redirect to the sync page
		if (req.xhr || req.headers.accept?.includes('application/json')) {
			res.json({
				success: true,
				message: 'Sync started successfully',
				syncId,
			});
		} else {
			// Send initial response to client for traditional page navigation
			if (!req.query.syncId) {
				// If no syncId was provided, redirect to the sync page with a new syncId
				return res.redirect(`/sync/sync-etsy?syncId=${syncId}`);
			}
			res.redirect('/sync');
		}
	} catch (error) {
		logger.error('Error starting Etsy sync:', { error: error.message });

		if (req.xhr || req.headers.accept?.includes('application/json')) {
			res.status(500).json({
				success: false,
				error: error.message,
			});
		} else {
			req.flash('error', `Error starting Etsy sync: ${error.message}`);
			res.redirect('/sync');
		}
	}
});

/**
 * Route to initiate a Shopify product synchronization
 * Starts the sync process in the background and returns immediately
 *
 * @route GET /sync/sync-shopify
 * @param {string} [req.query.syncId] - Optional sync ID for tracking progress
 * @returns {Object} JSON response with success status and syncId
 */
router.get('/sync-shopify', async (req, res) => {
	const syncId = validateSyncId(req.query.syncId, 'shopify', 'products');
	console.log(`Starting Shopify sync with syncId: ${syncId}`);

	// Initialize sync status
	initializeSyncStatus(syncId, 'shopify', 'products');
	// Start the sync process in the background, passing the syncId
	syncShopifyProducts(syncId) // Only pass syncId parameter to match the function signature
		.catch(error => {
			// This catch is for errors thrown *synchronously* before the async function really gets going
			// or if the async function itself isn't caught internally properly (should be avoided).
			logger.error('Error directly from syncShopifyProducts invocation:', {
				syncId,
				error: error.message,
			});
			updateSyncStatus(syncId, {
				complete: true,
				error: `Failed to start Shopify sync: ${error.message}`,
				progress: 100,
			});
		});

	// Respond immediately to the client with the syncId
	res.json({
		success: true,
		message: 'Shopify sync started successfully',
		syncId, // Return the syncId
	});
});

/**
 * Synchronizes Etsy products with the internal database
 * Fetches product data from Etsy, processes it, and updates the database
 * @param {string} syncId - The unique ID for this sync operation used for status tracking
 * @param {Object} req - Request object for flash messages in case of errors
 * @returns {Promise<void>}
 */
async function syncEtsyProducts(syncId, req) {
	const overallStartTime = performance.now();

	try {
		logger.info('Starting Etsy product sync', { syncId });

		// Verify authentication token is valid before proceeding
		const authService = require('../utils/auth-service');
		if (authService.isTokenExpired()) {
			logger.info(
				'Auth token expired, attempting to refresh before starting Etsy product sync',
				{ syncId }
			);
			try {
				await authService.refreshToken();
				logger.info('Auth token refreshed successfully for Etsy product sync', { syncId });
			} catch (authError) {
				logger.error('Failed to refresh auth token for Etsy product sync', {
					syncId,
					error: authError.message,
				});
				throw new Error(`Authentication failed: ${authError.message}`);
			}
		}

		const shop_id = await getShopId();
		updateSyncStatus(syncId, { currentPhase: 'Fetching listings' });

		// Fetch all listings
		const { listings, counts } = await fetchAllListings(shop_id, syncId);
		updateSyncStatus(syncId, {
			counts,
			processedCount: listings.length,
			progress: 30,
			currentPhase: 'Processing listings',
		});

		// Process listings
		const processStartTime = performance.now();
		const bulkOps = [];
		for (const listing of listings) {
			try {
				const inventory = listing.inventory;

				if (inventory?.products?.length) {
					// Handle listings with variations
					for (const product of inventory.products) {
						const sku =
							product.sku ||
							`ETSY-${listing.listing_id}${product.property_values?.length ? '-' + product.property_values.map(pv => pv.values[0]).join('-') : ''}`;

						bulkOps.push({
							updateOne: {
								filter: { sku },
								update: {
									$set: {
										sku,
										name: listing.title,
										raw_etsy_data: {
											listing,
											inventory,
											last_raw_sync: new Date(),
										},
										etsy_data: {
											listing_id: listing.listing_id.toString(),
											title: listing.title,
											description: listing.description,
											price: listing.price.amount / listing.price.divisor,
											quantity: product.offerings?.[0]?.quantity || 0,
											status: listing.state,
											tags: listing.tags || [],
											shipping_profile_id:
												listing.shipping_profile_id?.toString(),
											images:
												listing.images?.map(img => ({
													url: img.url_fullxfull,
													alt: img.alt_text || '',
												})) || [],
											last_synced: new Date(),
										},
									},
									$setOnInsert: {
										quantity_on_hand: product.offerings?.[0]?.quantity || 0,
									},
								},
								upsert: true,
							},
						});

						// Add variation details if they exist
						if (product.property_values?.length) {
							const properties = new Map();
							product.property_values.forEach(prop => {
								properties.set(prop.property_name, prop.values[0]);
							});
							bulkOps[bulkOps.length - 1].updateOne.update.$set.properties =
								properties;
						}
					}
				} else {
					// Handle listings without variations
					const sku = `ETSY-${listing.listing_id}`;
					bulkOps.push({
						updateOne: {
							filter: { sku },
							update: {
								$set: {
									sku,
									name: listing.title,
									raw_etsy_data: {
										listing,
										inventory: null,
										last_raw_sync: new Date(),
									},
									etsy_data: {
										listing_id: listing.listing_id.toString(),
										title: listing.title,
										description: listing.description,
										price: listing.price.amount / listing.price.divisor,
										quantity: listing.quantity,
										status: listing.state,
										tags: listing.tags || [],
										shipping_profile_id:
											listing.shipping_profile_id?.toString(),
										images:
											listing.images?.map(img => ({
												url: img.url_fullxfull,
												alt: img.alt_text || '',
											})) || [],
										last_synced: new Date(),
									},
								},
								$setOnInsert: {
									quantity_on_hand: listing.quantity,
								},
							},
							upsert: true,
						},
					});
				}
			} catch (error) {
				logger.error(`Error processing listing ${listing.listing_id}`, {
					error: error.message,
					listing_id: listing.listing_id,
				});
				continue;
			}
			updateSyncStatus(syncId, {
				progress: 50,
				currentPhase: 'Processing listings',
				processedCount: bulkOps.length,
				totalCount: listings.length,
			});
		}
		const processEndTime = performance.now();
		logger.info(
			`[Perf] Etsy listing processing loop took ${(processEndTime - processStartTime).toFixed(2)}ms`,
			{ syncId, count: listings.length }
		);

		updateSyncStatus(syncId, { progress: 70, currentPhase: 'Updating database' });

		// Perform bulk write
		if (bulkOps.length > 0) {
			const dbStartTime = performance.now();
			const result = await Product.bulkWrite(bulkOps, { ordered: false });
			const dbEndTime = performance.now();
			logger.info(
				`[Perf] Etsy Product.bulkWrite took ${(dbEndTime - dbStartTime).toFixed(2)}ms`,
				{
					syncId,
					inserted: result.insertedCount,
					updated: result.modifiedCount,
					upserted: result.upsertedCount,
				}
			);
		} else {
			logger.info('No Etsy product changes to write to database', { syncId });
		}

		// Clean up products based on shipping profiles
		updateSyncStatus(syncId, { progress: 90, currentPhase: 'Cleaning up' });
		const cleanupResult = await removeProductsWithUnselectedShippingProfiles();
		updateSyncStatus(syncId, { removedCount: cleanupResult.deletedCount || 0 });

		// Mark sync as complete
		completeSyncStatus(syncId);
		logger.info('Etsy product sync completed successfully', { syncId });

		// Record successful sync time in Settings
		await Settings.setSetting('lastEtsyProductSync', new Date().toISOString());
	} catch (error) {
		logger.error('Error syncing Etsy products in background', { error: error.message });
		// Update status with error
		completeSyncStatus(syncId, {}, error);

		// Set flash error to be shown on next page load - only if req exists (in manual sync)
		if (req && req.session) {
			req.session.flash = {
				error: `Error syncing products from Etsy: ${error.message}`,
			};
		}

		throw error; // Re-throw to be caught by the caller
	} finally {
		const overallEndTime = performance.now();
		logger.info(
			`[Perf] Overall syncEtsyProducts took ${(overallEndTime - overallStartTime).toFixed(2)}ms`,
			{ syncId }
		);
	}
}

/**
 * Finds the newest file in a directory
 * Used to find the most recent data files for Shopify bulk operations
 * @param {string} dirPath - Path to the directory to search
 * @returns {Promise<string|null>} Filename of the newest file or null if directory is empty
 */
async function getNewestFile(dirPath) {
	try {
		// Corrected: Call readdir directly on fs (which is fs.promises)
		const files = await fs.readdir(dirPath);

		if (files.length === 0) {
			return null; // Return null if the directory is empty
		}

		const filesWithStats = await Promise.all(
			files.map(async file => {
				const filePath = path.join(dirPath, file);
				// Corrected: Call stat directly on fs
				const stats = await fs.stat(filePath);
				return { file, stats };
			})
		);

		const newestFile = filesWithStats.reduce((prev, curr) => {
			return prev.stats.mtimeMs > curr.stats.mtimeMs ? prev : curr;
		});
		return newestFile.file;
	} catch (err) {
		console.error('Error reading directory:', err);
		throw err;
	}
}

/**
 * Cleans up old data files, keeping only the most recent ones
 * Removes older files with the specified prefix while keeping a specified number of newest files
 * @param {string} directoryPath - Path to the directory containing the data files
 * @param {string} prefix - Filename prefix to match
 * @param {number} keepCount - Number of recent files to keep (default: 5)
 * @returns {Promise<void>}
 */
async function cleanupDataFiles(directoryPath, prefix, keepCount = 5) {
	try {
		// Corrected: Call readdir directly on fs
		const files = await fs.readdir(directoryPath);
		const relevantFiles = files
			.filter(file => file.startsWith(prefix) && file.endsWith('.jsonl'))
			.map(file => {
				const filePath = path.join(directoryPath, file);
				const timestampMatch = file.match(/_(\d+)\.jsonl$/);
				const timestamp = timestampMatch ? parseInt(timestampMatch[1], 10) : 0;
				return { name: file, path: filePath, timestamp };
			})
			.sort((a, b) => b.timestamp - a.timestamp); // Sort descending by timestamp (newest first)

		if (relevantFiles.length > keepCount) {
			const filesToDelete = relevantFiles.slice(keepCount);
			logger.info(
				`Cleaning up ${filesToDelete.length} old data files with prefix "${prefix}"...`
			);
			for (const file of filesToDelete) {
				try {
					// Corrected: Call unlink directly on fs
					await fs.unlink(file.path);
					logger.debug(`Deleted old data file: ${file.name}`);
				} catch (unlinkError) {
					logger.error(`Error deleting file ${file.name}:`, unlinkError);
				}
			}
			logger.info(`Finished cleaning up old data files.`);
		} else {
			logger.info(`No old data files to clean up for prefix "${prefix}".`);
		}
	} catch (error) {
		logger.error('Error during data file cleanup:', error);
	}
}

/**
 * Synchronizes Shopify products with the internal database
 * Fetches product data from Shopify, processes it, and updates the database
 * @param {string} syncId - The unique ID for this sync operation used for status tracking
 * @param {Object} req - Optional request object for flash messages in case of errors
 * @returns {Promise<void>}
 */
async function syncShopifyProducts(syncId) {
	const overallStartTime = performance.now();
	const status = syncStatus.get(syncId);
	if (!status) {
		logger.error(`Sync status not found for syncId: ${syncId}. Aborting Shopify sync.`);
		return; // Cannot proceed without a status object
	}

	const directoryPath = path.resolve(__dirname, '..', 'data');
	const filePrefix = 'shopify_products_';
	let fileName = path.resolve(directoryPath, `${filePrefix}${Date.now()}.jsonl`);
	let url = null;
	let bulkOperationId = null;
	let ignoreCount = 0;

	try {
		updateSyncStatus(syncId, { currentPhase: 'Checking existing data', progress: 10 });

		const existingData = await getNewestFile(directoryPath);

		if (
			existingData &&
			existingData.startsWith(filePrefix) &&
			path.parse(existingData).name.split('_').pop() > Date.now() - 1000 * 60 * 60 * 2
		) {
			logger.info(`Using existing data file: ${existingData}`, { syncId });
			fileName = path.resolve(directoryPath, existingData);
			updateSyncStatus(syncId, { currentPhase: 'Using cached data', progress: 20 }); // Jump ahead if using cache
			url = 'local'; // Indicate local file usage
		} else {
			logger.info('Existing data file is old or missing, fetching new data from Shopify...', {
				syncId,
			});
			updateSyncStatus(syncId, { currentPhase: 'Requesting bulk export', progress: 15 });

			// Use direct Shopify client as in sync_old.js
			const shopify = new Shopify({
				shopName: process.env.SHOPIFY_SHOP_NAME,
				accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
			});

			const query = `mutation { bulkOperationRunQuery( query: """ { products { edges { node { id handle title descriptionHtml vendor status productType tags onlineStoreUrl media(first: 10) { edges { node { preview { image { url altText } } ... on MediaImage { image { id url altText } } } } } variants(first: 50) { edges { node { id sku price inventoryQuantity inventoryItem { id inventoryLevels(first: 10) { edges { node { location { id name } } } } } } } } }  } } } """ ) { bulkOperation { id status } userErrors { field message } } }`;

			try {
				logger.info('Requesting Shopify bulk product export...', { syncId });
				const initialResult = await shopify.graphql(query);
				logger.debug('Received initial result from Shopify GraphQL:', {
					syncId,
					initialResult,
				});

				if (initialResult.bulkOperationRunQuery?.userErrors?.length > 0) {
					logger.error('Shopify bulk operation user errors:', {
						syncId,
						errors: initialResult.bulkOperationRunQuery.userErrors,
					});
					// Throw error to be caught by the outer catch block which updates status
					throw new Error(
						`Shopify user errors: ${initialResult.bulkOperationRunQuery.userErrors.map(e => e.message).join(', ')}`
					);
				}

				if (!initialResult.bulkOperationRunQuery?.bulkOperation?.id) {
					logger.error(
						'Unexpected response structure from Shopify bulk operation initiation:',
						{ syncId, initialResult }
					);
					// Throw error to be caught by the outer catch block
					throw new Error('Failed to initiate Shopify bulk operation or retrieve ID.');
				}

				bulkOperationId = initialResult.bulkOperationRunQuery.bulkOperation.id;
				let operationStatus = initialResult.bulkOperationRunQuery.bulkOperation.status;
				logger.info(
					`Shopify bulk operation started. ID: ${bulkOperationId}, Status: ${operationStatus}`,
					{ syncId }
				);

				updateSyncStatus(syncId, {
					currentPhase: 'Polling bulk export status',
					progress: 20,
				});

				const queryJob = `query { node(id: "${bulkOperationId}") { ... on BulkOperation { id status errorCode createdAt completedAt objectCount fileSize url partialDataUrl } } }`;
				const MAX_POLL_ATTEMPTS = 60;
				const POLL_INTERVAL_MS = 5000;
				let pollAttempts = 0;

				while (pollAttempts < MAX_POLL_ATTEMPTS) {
					pollAttempts++;
					await shopifyHelpers.sleep(POLL_INTERVAL_MS);
					logger.debug(
						`Polling Shopify bulk operation status (Attempt ${pollAttempts})...`,
						{ syncId }
					);
					const pollResult = await shopify.graphql(queryJob);

					if (!pollResult.node) {
						logger.warn(`Bulk operation ${bulkOperationId} not found during polling.`, {
							syncId,
						});
						continue;
					}

					operationStatus = pollResult.node.status;
					logger.debug(`Bulk operation status: ${operationStatus}`, { syncId });

					// Update progress slightly during polling
					updateSyncStatus(syncId, {
						progress:
							20 + Math.min(60, Math.round((pollAttempts / MAX_POLL_ATTEMPTS) * 20)),
					}); // Progress from 20% to 40% during polling

					if (operationStatus === 'COMPLETED') {
						url = pollResult.node.url;
						logger.info(
							`Shopify bulk operation ${bulkOperationId} completed successfully. URL: ${url}`,
							{ syncId }
						);
						updateSyncStatus(syncId, {
							currentPhase: 'Downloading data',
							progress: 40,
						});
						break;
					} else if (operationStatus === 'FAILED') {
						logger.error(`Shopify bulk operation ${bulkOperationId} failed.`, {
							syncId,
							errorCode: pollResult.node.errorCode,
						});
						// Throw error to be caught by the outer catch block
						throw new Error(
							`Shopify bulk operation failed with code: ${pollResult.node.errorCode}`
						);
					} else if (operationStatus === 'CANCELED') {
						logger.warn(`Shopify bulk operation ${bulkOperationId} was canceled.`, {
							syncId,
						});
						// Throw error to be caught by the outer catch block
						throw new Error('Shopify bulk operation was canceled.');
					}
				}

				if (operationStatus !== 'COMPLETED') {
					logger.error(
						`Shopify bulk operation ${bulkOperationId} timed out after ${pollAttempts} attempts.`,
						{ syncId }
					);
					// Throw error to be caught by the outer catch block
					throw new Error('Shopify bulk operation timed out.');
				}
			} catch (err) {
				// Catch errors specifically from the bulk operation initiation/polling phase
				logger.error('Error during Shopify bulk operation initiation or polling:', {
					syncId,
					errorMessage: err.message,
					errorStack: err.stack,
				});
				// IMPORTANT: Re-throw the error so the main catch block handles status update
				throw err;
			}

			if (!url) {
				logger.warn('Skipping Shopify product download as no URL was obtained.', {
					syncId,
				});
				// Throw error to be caught by the outer catch block
				throw new Error('Failed to obtain download URL from Shopify bulk operation.');
			} else {
				logger.info(`Downloading Shopify product data from ${url}...`, { syncId });
				updateSyncStatus(syncId, { currentPhase: 'Downloading data', progress: 45 }); // Already set, but good to be explicit
				try {
					const response = await fetch(url);
					if (!response.ok || !response.body) {
						logger.error('Failed to download Shopify products file', {
							syncId,
							status: response.status,
							statusText: response.statusText,
						});
						throw new Error(
							`Failed to download Shopify products file: ${response.statusText}`
						);
					}

					updateSyncStatus(syncId, {
						currentPhase: 'Downloading data...',
						progress: 46,
					});

					await fs.mkdir(directoryPath, { recursive: true }); // Use fs.promises.mkdir
					const fileWriteStream = fsSync.createWriteStream(fileName); // Use fs.createWriteStream
					if (typeof Readable.fromWeb === 'function') {
						const readableWebStream = Readable.fromWeb(response.body);
						await pipeline(readableWebStream, fileWriteStream);
					} else {
						logger.warn('Readable.fromWeb not available. Stream piping might fail.', {
							syncId,
						});
						throw new Error(
							'Node version too old for efficient stream handling from fetch response.'
						);
					}
					logger.info(`Shopify product data downloaded successfully to ${fileName}`, {
						syncId,
					});
					updateSyncStatus(syncId, { progress: 50 });
				} catch (downloadError) {
					logger.error('Error downloading or saving Shopify product data:', {
						syncId,
						error: downloadError,
					});
					throw downloadError; // Re-throw for main catch block
				}
			}
		}

		// --- Process downloaded data ---
		if (url && fileName) {
			logger.info(`Processing Shopify data from file: ${fileName}`, { syncId });
			updateSyncStatus(syncId, { currentPhase: 'Processing data', progress: 55 });
			const fileReadStream = fsSync.createReadStream(fileName); // Use fsSync for streams
			const rl = readline.createInterface({
				input: fileReadStream,
				crlfDelay: Infinity,
			});

			const allProducts = {};
			const variantToProductMap = {};
			let lineCount = 0;

			// Update progress periodically during file reading
			const progressInterval = setInterval(() => {
				updateSyncStatus(syncId, {
					currentPhase: `Processing data (${lineCount} lines)`,
					processedCount: lineCount,
				});
			}, 1000); // Update every second

			rl.on('line', line => {
				// ... (keep existing line processing logic) ...
				lineCount++;
				try {
					if (!line.trim()) return;
					const jsonLine = JSON.parse(line);
					// --- Existing JSON processing logic ---
					if (jsonLine.__parentId) {
						const parentId = jsonLine.__parentId;
						if (jsonLine.preview?.image || jsonLine.image) {
							if (!allProducts[parentId]) {
								logger.warn(
									`Parent product ${parentId} not found for image line:`,
									{ syncId, jsonLine }
								);
								return;
							}
							const imageInfo = jsonLine.image || jsonLine.preview?.image;
							if (imageInfo) {
								allProducts[parentId].images.push({
									id: imageInfo.id,
									url: imageInfo.url,
									alt: imageInfo.altText || null,
								});
							}
						} else if (jsonLine.location) {
							const variantId = parentId;
							const mapping = variantToProductMap[variantId];
							if (mapping) {
								const { productId } = mapping;
								const product = allProducts[productId];
								const variant = product?.variants.find(v => v.id === variantId);
								if (variant) {
									if (!variant.inventoryLevels) variant.inventoryLevels = [];
									variant.inventoryLevels.push({
										locationName: jsonLine.location.name,
										locationId: jsonLine.location.id,
									});
								} else {
									logger.warn(
										`InventoryLevel line: Variant ${variantId} not found within Product ${productId}`,
										{ syncId, line: jsonLine, productId, variantId }
									);
								}
							} else {
								logger.error(
									`InventoryLevel line: Mapping not found for variant ID: ${variantId}.`,
									{ syncId, line: jsonLine }
								);
							}
						} else if (jsonLine.sku !== undefined) {
							if (!allProducts[parentId]) {
								logger.warn(
									`Parent product ${parentId} not found for variant line:`,
									{ syncId, jsonLine }
								);
								return;
							}
							const variantData = {
								id: jsonLine.id,
								sku: jsonLine.sku,
								price: jsonLine.price,
								inventoryQuantity: jsonLine.inventoryQuantity,
								inventoryItemId: jsonLine.inventoryItem?.id,
								inventoryLevels: [],
							};
							allProducts[parentId].variants.push(variantData);
							const productId = parentId;
							const variantId = jsonLine.id;
							const inventoryItemId = jsonLine.inventoryItem?.id;
							variantToProductMap[variantId] = {
								productId: productId,
								inventoryItemId: inventoryItemId,
							};
							if (!jsonLine.sku && !allProducts[parentId].ignore) {
								allProducts[parentId].ignore = 'check sku';
							}
						} else {
							logger.warn('Unknown child object type in JSONL:', {
								syncId,
								jsonLine,
							});
						}
					} else if (jsonLine.id && jsonLine.title) {
						const productId = jsonLine.id;
						allProducts[productId] = {
							id: productId,
							handle: jsonLine.handle,
							title: jsonLine.title,
							descriptionHtml: jsonLine.descriptionHtml,
							vendor: jsonLine.vendor,
							status: jsonLine.status,
							productType: jsonLine.productType,
							tags: jsonLine.tags || [],
							onlineStoreUrl: jsonLine.onlineStoreUrl,
							images: [],
							variants: [],
							ignore: false,
						};
						if (
							!(
								jsonLine.vendor === 'The Bearcub Book Den' ||
								jsonLine.vendor === 'Sprinkles Studios'
							)
						) {
							allProducts[productId].ignore = true;
						}
					} else {
						logger.warn('Skipping unrecognized line in JSONL:', {
							syncId,
							line: line.substring(0, 100),
						});
					}
				} catch (parseError) {
					logger.error(`Error parsing JSONL line ${lineCount}: ${parseError.message}`, {
						syncId,
						fileName,
						lineNumber: lineCount,
						lineContent: line.substring(0, 500),
					});
				}
			});
			await new Promise((resolve, reject) => {
				rl.on('close', () => {
					clearInterval(progressInterval); // Clear the interval when processing is done
					resolve();
				});
				rl.on('error', err => {
					clearInterval(progressInterval); // Clear the interval on error
					reject(err);
				});
				fileReadStream.on('error', err => {
					clearInterval(progressInterval); // Clear the interval on stream error
					reject(err);
				});
			});

			logger.info(
				`Finished initial processing of ${fileName}. Processed ${lineCount} lines. Found ${Object.keys(allProducts).length} products.`,
				{ syncId }
			);
			updateSyncStatus(syncId, { syncCount: Object.keys(allProducts).length, progress: 70 }); // Update total count

			// --- Database Update Logic ---
			logger.info('Preparing database updates for Shopify products...', { syncId });
			updateSyncStatus(syncId, { currentPhase: 'Updating database', progress: 75 });
			const bulkOps = [];
			const syncTimestamp = new Date();
			ignoreCount = 0; // Reset ignore count for this phase
			const totalProducts = Object.keys(allProducts).length;
			let processedProducts = 0;

			for (const productId in allProducts) {
				// Update progress periodically during product processing
				processedProducts++;
				if (processedProducts % 20 === 0 || processedProducts === totalProducts) {
					const progressPercent =
						75 + Math.floor((processedProducts / totalProducts) * 10);
					updateSyncStatus(syncId, {
						currentPhase: `Preparing database updates (${processedProducts}/${totalProducts})`,
						progress: progressPercent,
						processedCount: processedProducts,
						totalCount: totalProducts,
					});
				}

				// ... (keep existing variant processing and bulkOps creation logic) ...
				const shopifyProduct = allProducts[productId];
				if (shopifyProduct.ignore === true) {
					ignoreCount++;
					continue;
				}
				if (shopifyProduct.ignore === 'check sku') {
					logger.warn(
						`Product "${shopifyProduct.title}" (${productId}) needs SKU check.`,
						{ syncId }
					);
					continue;
				}
				for (const variant of shopifyProduct.variants) {
					if (!variant.sku) {
						logger.warn(
							`Skipping variant without SKU for product "${shopifyProduct.title}" (${productId}), variant ID ${variant.id}`,
							{ syncId }
						);
						continue;
					}
					bulkOps.push({
						updateOne: {
							filter: { sku: variant.sku },
							update: {
								$set: {
									sku: variant.sku,
									name: shopifyProduct.title,
									'shopify_data.product_id': shopifyProduct.id,
									'shopify_data.variant_id': variant.id,
									'shopify_data.title': shopifyProduct.title,
									'shopify_data.description': shopifyProduct.descriptionHtml,
									'shopify_data.price': parseFloat(variant.price || 0),
									'shopify_data.inventory_quantity': variant.inventoryQuantity,
									'shopify_data.tags': shopifyProduct.tags,
									'shopify_data.images': shopifyProduct.images.map(img => ({
										url: img.url,
										alt: img.alt,
									})),
									'shopify_data.handle': shopifyProduct.handle,
									'shopify_data.vendor': shopifyProduct.vendor,
									'shopify_data.product_type': shopifyProduct.productType,
									'shopify_data.status': shopifyProduct.status,
									'shopify_data.last_synced': syncTimestamp,
									raw_shopify_data: {
										product: shopifyProduct,
										variant: variant,
										last_raw_sync: syncTimestamp,
									},
									last_updated: syncTimestamp,
								},
								$setOnInsert: {
									quantity_on_hand: variant.inventoryQuantity || 0,
									quantity_committed: 0,
								},
							},
							upsert: true,
						},
					});
				}
			}

			logger.info(`Prepared ${bulkOps.length} database update operations.`, { syncId });
			if (ignoreCount > 0) {
				logger.info(`Ignored ${ignoreCount} products based on vendor or other criteria.`, {
					syncId,
				});
			}
			updateSyncStatus(syncId, { syncCount: bulkOps.length }); // Refine sync count to actual operations

			if (bulkOps.length > 0) {
				logger.info('Performing bulk write operation to database...', { syncId });
				updateSyncStatus(syncId, { progress: 85 });
				try {
					const result = await Product.bulkWrite(bulkOps);
					logger.info('Database bulk write completed.', {
						syncId,
						upserted: result.upsertedCount,
						modified: result.modifiedCount,
					});
					// Update status counts based on result
					updateSyncStatus(syncId, {
						counts: { added: result.upsertedCount, updated: result.modifiedCount },
					}); // Example counts, adjust as needed
				} catch (dbError) {
					logger.error('Error during database bulk write:', { syncId, error: dbError });
					throw dbError; // Re-throw for main catch block
				}
			} else {
				logger.info('No valid Shopify products found to update in the database.', {
					syncId,
				});
				updateSyncStatus(syncId, {
					counts: { added: 0, updated: 0 },
					progress: 85, // Ensure progress is updated even when there are no changes
				});
			}
			updateSyncStatus(syncId, { progress: 95 });
		} else {
			logger.info(
				'Skipping database update because no Shopify data was downloaded or processed.',
				{ syncId }
			);
			// If we skipped download due to cache, we still need to mark as complete later
			if (url !== 'local') {
				// If we didn't use local cache and didn't process, it implies an earlier error handled by throw
				// If we *did* use local cache, we fall through to cleanup/completion
			}
		}

		// --- Data File Cleanup ---
		logger.info('Cleaning up old data files...', { syncId });
		updateSyncStatus(syncId, { currentPhase: 'Cleaning up', progress: 95 });
		await cleanupDataFiles(directoryPath, filePrefix, 5);

		// Ensure progress is set to 100% before completing
		updateSyncStatus(syncId, { progress: 100, currentPhase: 'Sync complete' });

		logger.info('Shopify product sync process finished successfully.', { syncId });
		completeSyncStatus(syncId);

		// Record successful sync time ONLY if the operation didn't fail early
		// Check if url is not null (meaning bulk op likely succeeded or we used cache)
		if (url) {
			await Settings.setSetting('lastShopifyProductSync', new Date().toISOString());
		}
	} catch (error) {
		// Main catch block for the entire function
		logger.error('Error during Shopify product sync process:', {
			syncId,
			error: error.message,
			stack: error.stack,
		});

		// Update status with error details
		completeSyncStatus(syncId, {}, error);

		// No req.flash here as this runs in the background

		// Ensure cleanup still runs if possible
		try {
			await cleanupDataFiles(directoryPath, filePrefix, 5);
		} catch (cleanupErr) {
			logger.error('Error during cleanup after sync failure:', { syncId, error: cleanupErr });
		}
	} finally {
		const overallEndTime = performance.now();
		logger.info(
			`[Perf] Overall syncShopifyProducts took ${(overallEndTime - overallStartTime).toFixed(2)}ms`,
			{ syncId }
		);
		// Optional: Clean up status map entry after some time if needed, similar to Etsy sync status route
		// setTimeout(() => { syncStatus.delete(syncId); }, 30 * 60 * 1000); // Example: 30 mins
	}
}

/**
 * Route to synchronize orders from a specified marketplace
 * Delegates to either syncEtsyOrders or syncShopifyOrders based on marketplace parameter
 *
 * @route GET /sync/sync-orders
 * @param {string} req.query.marketplace - The marketplace to sync orders from ('etsy' or 'shopify')
 * @param {string} [req.query.syncId] - Optional sync ID for tracking progress
 * @returns {Object} JSON response with sync status and syncId
 */
router.get('/sync-orders', async (req, res) => {
	const marketplace = req.query.marketplace || 'etsy';

	// Validate marketplace parameter
	if (marketplace !== 'etsy' && marketplace !== 'shopify') {
		req.flash('error', 'Invalid marketplace specified');
		return res.redirect('/sync');
	}

	// Call the appropriate sync function based on marketplace
	if (marketplace === 'etsy') {
		return await syncEtsyOrders(req, res);
	} else if (marketplace === 'shopify') {
		return await syncShopifyOrders(req, res);
	}
});

/**
 * Synchronizes Etsy orders with the internal database
 * Fetches order data from Etsy API, processes it, and updates the database
 *
 * @param {Object} req - Express request object with syncId query parameter
 * @param {Object} res - Express response object
 * @returns {Promise<void>} - Resolves when sync is complete, with response sent if res is provided
 * @throws {Error} - If there's an error during the synchronization process
 */
async function syncEtsyOrders(req, res) {
	// TODO: Update to resync all unshipped orders
	// TODO: If is_shipped, set ship date to latest timestamp of transaction in the order.

	const syncId = validateSyncId(req.query.syncId, 'etsy', 'orders');

	// Initialize sync status
	initializeSyncStatus(syncId, 'etsy', 'orders');

	const overallStartTime = performance.now();
	let requestTimings = [];
	try {
		logger.info('Starting Etsy order sync', { syncId });
		const shopId = await getShopId();
		const tokenData = JSON.parse(process.env.TOKEN_DATA);
		const limit = 100;
		let allOrders = [];
		let newOrderCount = 0;
		let updatedOrderCount = 0;
		let lastSyncTime = await Settings.getSetting('lastEtsyOrderSync');
		let minCreated;
		if (lastSyncTime) {
			const overlapMs = 24 * 60 * 60 * 1000; // 1 day overlap
			minCreated = Math.floor((new Date(lastSyncTime).getTime() - overlapMs) / 1000);
		} else {
			const orderSyncDays = parseInt(process.env.ORDER_SYNC_DAYS || '90', 10);
			minCreated = Math.floor((Date.now() - orderSyncDays * 24 * 60 * 60 * 1000) / 1000);
		}
		const headers = {
			'x-api-key': process.env.ETSY_API_KEY,
			Authorization: `Bearer ${tokenData.access_token}`,
		};
		// First, fetch the first page to get the total count
		const firstUrl = `${API_BASE_URL}/application/shops/${shopId}/receipts?limit=${limit}&offset=0&min_created=${minCreated}`;
		const reqStart = Date.now();
		updateSyncStatus(syncId, { currentPhase: 'Fetching first page of orders', progress: 10 });
		let response = await etsyRequest(() => etsyFetch(firstUrl, { headers }), {
			endpoint: '/receipts',
			method: 'GET',
			offset: 0,
			syncId,
		});
		let reqDuration = Date.now() - reqStart;
		requestTimings.push(reqDuration);
		logger.info(`Fetched batch in ${reqDuration}ms (offset=0)`);
		if (!response.ok) {
			const errorText = await response.text();
			logger.error('Failed to fetch Etsy orders', {
				status: response.status,
				error: errorText,
			});
			throw new Error(`Failed to fetch Etsy orders: ${response.statusText}`);
		}
		const data = await response.json();
		const orders = data.results || [];
		allOrders.push(...orders);
		let totalCount =
			typeof data.count === 'number' && isFinite(data.count) && data.count > 0
				? data.count
				: orders.length;
		const totalPages = Math.ceil(totalCount / limit);
		updateSyncStatus(syncId, {
			currentPhase: `Fetching orders (${totalPages} pages)`,
			progress: 15,
			syncCount: allOrders.length,
			totalCount,
			processedCount: allOrders.length,
		});
		if (orders.length < limit || totalPages <= 1) {
			logger.info(`Fetched ${allOrders.length} Etsy orders in date range (single page)`);
		} else if (totalPages > 10000) {
			logger.error(
				`Unreasonable totalPages value: ${totalPages}. Aborting sync to prevent memory issues.`
			);
			throw new Error('Etsy API returned an unreasonable count for pagination.');
		} else {
			// Prepare offsets for all remaining pages
			const offsets = [];
			for (let i = 1; i < totalPages; i++) {
				offsets.push(i * limit);
			}
			let index = 0;
			const results = [];
			async function fetchPage(offset) {
				let retries = 0;
				while (retries < 5) {
					const url = `${API_BASE_URL}/application/shops/${shopId}/receipts?limit=${limit}&offset=${offset}&min_created=${minCreated}`;
					const reqStart = Date.now();
					try {
						logger.debug(`Fetching Etsy orders: ${url}`);
						let resp = await etsyRequest(() => etsyFetch(url, { headers }), {
							endpoint: '/receipts',
							method: 'GET',
							offset,
							syncId,
						});
						let reqDuration = Date.now() - reqStart;
						requestTimings.push(reqDuration);
						logger.info(`Fetched batch in ${reqDuration}ms (offset=${offset})`);
						if (!resp.ok) {
							const errorText = await resp.text();
							logger.error('Failed to fetch Etsy orders', {
								status: resp.status,
								error: errorText,
							});
							throw new Error(`Failed to fetch Etsy orders: ${resp.statusText}`);
						}
						const data = await resp.json();
						return data.results || [];
					} catch (err) {
						logger.error('Error fetching Etsy orders page', {
							offset,
							error: err.message,
						});
						await new Promise(r => setTimeout(r, 1000 * Math.pow(2, retries)));
						retries++;
					}
				}
				logger.error('Failed to fetch Etsy orders after retries', { offset });
				return [];
			}
			async function worker() {
				while (index < offsets.length) {
					const myIndex = index++;
					const offset = offsets[myIndex];
					const res = await fetchPage(offset);
					results.push(...res);
					// Get a fresh reference to the status object to avoid using a stale variable
					const currentCount = allOrders.length + results.length;
					updateSyncStatus(syncId, {
						syncCount: currentCount,
						progress: 15 + Math.round((currentCount / totalCount) * 60),
						currentPhase: `Fetching orders (page ${Math.floor((currentCount / totalCount) * totalPages) + 1} of ${totalPages})`,
					});
				}
			}
			await Promise.all(
				Array(ORDER_SYNC_CONCURRENCY)
					.fill(0)
					.map(() => worker())
			);
			allOrders.push(...results);
		}
		updateSyncStatus(syncId, {
			currentPhase: 'Processing orders',
			progress: 80,
			syncCount: allOrders.length,
			processedCount: allOrders.length,
		});
		// Prepare bulkWrite operations
		const bulkOps = [];
		const existingOrders = await Order.find({
			order_id: { $in: allOrders.map(o => o.receipt_id?.toString()) },
			marketplace: 'etsy',
		}).lean();
		const existingOrderMap = new Map(existingOrders.map(o => [o.order_id, o]));
		for (const [i, etsyOrderData] of allOrders.entries()) {
			const receiptIdStr = etsyOrderData.receipt_id?.toString();
			if (!receiptIdStr) continue;
			const existing = existingOrderMap.get(receiptIdStr);
			const timestamp = etsyOrderData.created_timestamp;
			if (typeof timestamp !== 'number' || timestamp <= 0) continue;
			const orderDate = new Date(timestamp * 1000);
			if (isNaN(orderDate.getTime())) continue;
			const items = (etsyOrderData.transactions || []).map(tx => ({
				marketplace: 'etsy',
				sku: tx.sku || 'UNKNOWN',
				quantity: tx.quantity,
				is_digital: tx.is_digital,
				receipt_id: receiptIdStr,
				listing_id: tx.listing_id?.toString(),
				transaction_id: tx.transaction_id?.toString(),
			}));
			const update = {
				$set: {
					etsy_order_data: etsyOrderData,
					marketplace: 'etsy',
					status: etsyOrderData.is_shipped ? 'shipped' : 'unshipped', // Status updated here
					buyer_name: etsyOrderData.name || existing?.buyer_name || 'N/A',
					order_date: orderDate,
					receipt_id: receiptIdStr,
					items,
				},
			};
			bulkOps.push({
				updateOne: {
					filter: { order_id: receiptIdStr, marketplace: 'etsy' },
					update: update,
					upsert: true,
				},
			});
			updateSyncStatus(syncId, {
				currentPhase: `Processing orders (${i + 1} of ${allOrders.length})`,
				progress: 80 + Math.round(((i + 1) / allOrders.length) * 15),
				syncCount: i + 1,
				processedCount: i + 1,
			});
		}
		let result = { upsertedCount: 0, modifiedCount: 0 };
		if (bulkOps.length > 0) {
			updateSyncStatus(syncId, { currentPhase: 'Writing to database', progress: 97 });
			result = await Order.bulkWrite(bulkOps, { ordered: false });
		}
		newOrderCount = result.upsertedCount || 0;
		updatedOrderCount = result.modifiedCount || 0;
		logger.info(
			`Successfully synced ${newOrderCount} new and ${updatedOrderCount} existing Etsy orders`,
			{ syncId }
		);
		completeSyncStatus(syncId);
		await Settings.setSetting('lastEtsyOrderSync', new Date().toISOString());
		if (res)
			res.json({
				success: true,
				message: `Synced ${newOrderCount} new and ${updatedOrderCount} existing Etsy orders.`,
				syncId,
			});
	} catch (error) {
		logger.error('Error syncing Etsy orders:', {
			syncId,
			error: error.message,
			stack: error.stack,
		});
		completeSyncStatus(syncId, {}, error);
		if (res) {
			res.status(500).json({ success: false, error: error.message });
		}
	} finally {
		const overallEndTime = performance.now();
		logger.info(
			`[Perf] Overall syncEtsyOrders took ${(overallEndTime - overallStartTime).toFixed(2)}ms`,
			{ syncId }
		);
	}
}

/**
 * Synchronizes Shopify orders with the internal database
 * Fetches order data from Shopify using GraphQL API, processes it, and updates the database
 *
 * @param {string|Object} req - Either the syncId string or the Express request object with syncId query parameter
 * @param {Object} [res] - Express response object if called from a route handler, optional if called programmatically
 * @returns {Promise<void>} - Resolves when sync is complete, with response sent if res is provided
 * @throws {Error} - If there's an error during the synchronization process
 */
async function syncShopifyOrders(req, res) {
	const syncId = validateSyncId(req?.query?.syncId || req, 'shopify', 'orders');
	const BATCH_SIZE = 100; // Shopify GraphQL API limit for orders
	const ORDER_SYNC_DAYS = parseInt(process.env.ORDER_SYNC_DAYS || '90', 10);
	const overallStartTime = performance.now();
	let newOrders = 0;
	let updatedOrders = 0;

	// Initialize sync status
	initializeSyncStatus(syncId, 'shopify', 'orders');

	try {
		logger.info('Starting Shopify order sync using GraphQL', {
			syncId,
			orderSyncDays: ORDER_SYNC_DAYS,
		});
		updateSyncStatus(syncId, { currentPhase: 'Initializing Shopify order sync', progress: 5 });

		// Initialize Shopify client
		const shopify = new Shopify({
			shopName: process.env.SHOPIFY_SHOP_NAME,
			accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
		});

		// Array to store all orders
		let allShopifyOrders = [];

		// Calculate timestamp for specified days ago
		const date = new Date();
		date.setDate(date.getDate() - ORDER_SYNC_DAYS);
		const formattedDate = date.toISOString();
		logger.info(`Fetching Shopify orders created after: ${formattedDate}`, { syncId });

		// TODO: Add ship date to query
		// GraphQL fragment with fields to retrieve for each order
		const orderFieldsFragment = `{
            pageInfo {
                hasNextPage
                endCursor
            }
            nodes {
                id
                name
                email
                phone
                totalPriceSet {
                    shopMoney {
                        amount
                        currencyCode
                    }
                }
                displayFinancialStatus
                displayFulfillmentStatus
                createdAt
                processedAt
                customer {
                    id
                    firstName
                    lastName
                    email
                }
                lineItems(first: 250) {
                    nodes {
                        id
                        title
                        quantity
                        variant {
                            id
                            sku
                            product {
                                id
                            }
                        }
                        requiresShipping
                    }
                }
            }
        }`;

		// Initial query for first batch of orders
		let query = `{
            orders(first: ${BATCH_SIZE}, query: "created_at:>=${formattedDate}") ${orderFieldsFragment}
        }`;

		// Execute initial query
		updateSyncStatus(syncId, { currentPhase: 'Fetching first batch of orders', progress: 10 });
		let result = await shopify.graphql(query);

		if (!result || !result.orders || !result.orders.nodes) {
			logger.error('Error fetching orders from Shopify: Unexpected response structure', {
				syncId,
			});
			throw new Error('Failed to fetch orders from Shopify: Invalid response structure');
		}

		// Process first batch
		logger.info(`Fetched initial batch of ${result.orders.nodes.length} orders from Shopify`, {
			syncId,
		});
		allShopifyOrders.push(...result.orders.nodes);

		// Variables for pagination and progress tracking
		let hasNextPage = result.orders.pageInfo.hasNextPage;
		let endCursor = result.orders.pageInfo.endCursor;
		let daysRunningTotal = 0;
		let batchCount = 1;

		// Calculate approximate timespan of first batch for progress estimation
		if (result.orders.nodes.length > 1) {
			const firstOrderDate = new Date(result.orders.nodes[0].createdAt);
			const lastOrderDate = new Date(
				result.orders.nodes[result.orders.nodes.length - 1].createdAt
			);
			daysRunningTotal = Math.abs(firstOrderDate - lastOrderDate) / (1000 * 60 * 60 * 24);
		}

		// Fetch remaining pages
		while (hasNextPage) {
			batchCount++;
			updateSyncStatus(syncId, {
				currentPhase: `Fetching order batch #${batchCount}`,
				progress: 10 + Math.min(60, Math.round((daysRunningTotal / ORDER_SYNC_DAYS) * 60)),
			});

			// Query for next page using cursor
			query = `{
                orders(first: ${BATCH_SIZE}, after: "${endCursor}", query: "created_at:>=${formattedDate}") ${orderFieldsFragment}
            }`;

			try {
				// Add delay to avoid rate limiting
				await shopifyHelpers.sleep(500);

				// Execute query for next page
				result = await shopify.graphql(query);

				if (!result || !result.orders || !result.orders.nodes) {
					logger.warn(`Invalid response for batch #${batchCount}, skipping`, { syncId });
					break;
				}

				const tempOrderCount = result.orders.nodes.length;

				if (tempOrderCount > 0) {
					// Add orders to our collection
					allShopifyOrders.push(...result.orders.nodes);

					// Update pagination variables
					hasNextPage = result.orders.pageInfo.hasNextPage;
					endCursor = result.orders.pageInfo.endCursor;

					// Calculate date span for progress estimation
					if (tempOrderCount > 1) {
						const firstOrderDate = new Date(result.orders.nodes[0].createdAt);
						const lastOrderDate = new Date(
							result.orders.nodes[result.orders.nodes.length - 1].createdAt
						);
						const batchDays =
							Math.abs(firstOrderDate - lastOrderDate) / (1000 * 60 * 60 * 24);
						daysRunningTotal += batchDays;
					}

					// Estimate total orders based on current rate and remaining days
					const averageOrdersPerDay =
						allShopifyOrders.length / Math.max(daysRunningTotal, 1);
					const daysRemaining = Math.max(0, ORDER_SYNC_DAYS - daysRunningTotal);
					const estimatedTotal = Math.ceil(
						averageOrdersPerDay * daysRemaining + allShopifyOrders.length
					);

					logger.info(
						`Fetched batch #${batchCount} with ${tempOrderCount} orders, total so far: ${allShopifyOrders.length}`,
						{
							syncId,
							estimatedTotal,
							daysProcessed: daysRunningTotal,
							averageOrdersPerDay,
						}
					);

					// Update sync status with current progress
					updateSyncStatus(syncId, {
						syncCount: allShopifyOrders.length,
						processedCount: allShopifyOrders.length,
						totalCount: estimatedTotal,
						progress:
							10 +
							Math.min(60, Math.round((daysRunningTotal / ORDER_SYNC_DAYS) * 60)),
					});
				} else {
					// No orders in this batch, end pagination
					hasNextPage = false;
					logger.info(`No orders in batch #${batchCount}, ending pagination`, { syncId });
				}
			} catch (error) {
				// Log error but try to continue with orders collected so far
				logger.error(`Error fetching batch #${batchCount}`, {
					syncId,
					error: error.message,
				});

				// Stop pagination if we've had an error
				hasNextPage = false;

				// Only throw if we haven't fetched any orders yet
				if (allShopifyOrders.length === 0) {
					throw new Error(`Failed to fetch orders: ${error.message}`);
				}
			}
		}

		// Final count of fetched orders
		const orderCount = allShopifyOrders.length;
		logger.info(`Completed fetching ${orderCount} Shopify orders`, { syncId });

		// Process orders for database updates
		if (orderCount > 0) {
			updateSyncStatus(syncId, {
				currentPhase: 'Processing orders for database update',
				progress: 70,
				syncCount: orderCount,
				totalCount: orderCount,
			});

			// Lookup existing orders to determine new vs updated
			const orderIds = allShopifyOrders.map(o => `shopify-${o.id.split('/').pop()}`);
			logger.info(`Looking up ${orderIds.length} orders in database`, { syncId });

			const existingOrders = await Order.find({
				order_id: { $in: orderIds },
				marketplace: 'shopify',
			}).lean();

			const existingOrderMap = new Map(existingOrders.map(o => [o.order_id, o]));
			logger.info(`Found ${existingOrders.length} existing Shopify orders in database`, {
				syncId,
			});

			// Prepare database operations
			const bulkOps = [];

			// Process all orders
			for (const [i, shopifyOrder] of allShopifyOrders.entries()) {
				try {
					// Extract clean ID from GraphQL ID (remove gid://shopify/Order/ prefix)
					const shopifyId = shopifyOrder.id.split('/').pop();
					const orderId = `shopify-${shopifyId}`;
					const existing = existingOrderMap.get(orderId);

					// Extract line items
					const items = (shopifyOrder.lineItems?.nodes || []).map(item => {
						const variantId = item.variant?.id?.split('/').pop();
						const productId = item.variant?.product?.id?.split('/').pop();
						return {
							marketplace: 'shopify',
							line_item_id: item.id?.split('/').pop(),
							product_id: productId,
							variant_id: variantId,
							sku: item.variant?.sku || `SHOPIFY-${productId}-${variantId}`,
							quantity: item.quantity,
							is_digital: item.requiresShipping === false,
							title: item.title,
						};
					});

					// Prepare update operation
					const update = {
						$set: {
							order_id: orderId,
							marketplace: 'shopify',
							shopify_order_number: shopifyOrder.name,
							order_date: new Date(shopifyOrder.createdAt),
							buyer_name:
								`${shopifyOrder.customer?.firstName || ''} ${shopifyOrder.customer?.lastName || ''}`.trim(),
							receipt_id: orderId,
							items,
							shopify_order_data: shopifyOrder,
							financial_status: shopifyOrder.displayFinancialStatus,
							fulfillment_status: shopifyOrder.displayFulfillmentStatus,
							status:
								shopifyOrder.displayFulfillmentStatus === 'FULFILLED'
									? 'shipped'
									: 'unshipped', // Status updated here
							last_updated: new Date(),
						},
					};

					// Add to bulk operations
					bulkOps.push({
						updateOne: {
							filter: { order_id: orderId, marketplace: 'shopify' },
							update,
							upsert: true,
						},
					});

					// Track if new or updated
					if (existing) {
						updatedOrders++;
					} else {
						newOrders++;
					}

					// Update progress periodically
					if (i % 50 === 0 || i === allShopifyOrders.length - 1) {
						updateSyncStatus(syncId, {
							currentPhase: `Processing orders (${i + 1} of ${allShopifyOrders.length})`,
							progress: 70 + Math.round(((i + 1) / allShopifyOrders.length) * 20),
							processedCount: i + 1,
							totalCount: allShopifyOrders.length,
						});
					}
				} catch (error) {
					// Log error but continue with next order
					logger.error(`Error processing order ${shopifyOrder.id || 'unknown'}`, {
						syncId,
						error: error.message,
						order: shopifyOrder.id || 'unknown',
					});
				}
			}

			// Perform database operations
			if (bulkOps.length > 0) {
				updateSyncStatus(syncId, {
					currentPhase: 'Writing to database',
					progress: 95,
					processedCount: allShopifyOrders.length,
				});

				logger.info(`Writing ${bulkOps.length} order operations to database`, { syncId });

				// Execute bulk write operation
				const result = await Order.bulkWrite(bulkOps, { ordered: false });

				// Log results
				logger.info('Database write complete', {
					syncId,
					upserted: result.upsertedCount,
					modified: result.modifiedCount,
					matched: result.matchedCount,
					newOrders,
					updatedOrders,
				});

				// Update sync status with counts
				updateSyncStatus(syncId, {
					counts: {
						added: result.upsertedCount || 0,
						updated: result.modifiedCount || 0,
					},
				});
			} else {
				logger.info('No orders to write to database', { syncId });
			}
		} else {
			logger.info('No Shopify orders found to process', { syncId });
		}

		// Mark sync as complete
		completeSyncStatus(syncId);

		// Update last sync time setting
		await Settings.setSetting('lastShopifyOrderSync', new Date().toISOString());

		// Return response if this was called from an HTTP endpoint
		if (res) {
			const message = `Successfully synced ${orderCount} Shopify orders (${newOrders || 0} new, ${updatedOrders || 0} updated)`;
			logger.info(message, { syncId });

			res.json({
				success: true,
				message,
				syncId,
			});
		}
	} catch (error) {
		// Handle any errors that occurred during the sync
		logger.error('Error syncing Shopify orders:', {
			syncId,
			error: error.message,
			stack: error.stack,
		});

		// Mark sync as failed
		completeSyncStatus(syncId, {}, error);

		// Return error response if this was called from an HTTP endpoint
		if (res) {
			res.status(500).json({
				success: false,
				error: error.message,
			});
		}
	} finally {
		const overallEndTime = performance.now();
		logger.info(
			`[Perf] Overall syncShopifyOrders took ${(overallEndTime - overallStartTime).toFixed(2)}ms`,
			{ syncId }
		);
	}
}

/**
 * Performs a full synchronization of products for both Etsy and Shopify.
 * This function is intended to be called by the scheduler.
 */
async function performFullSync() {
	logger.info('Starting performFullSync...');
	const etsySyncId = validateSyncId(null, 'etsy', 'products-auto');
	const shopifySyncId = validateSyncId(null, 'shopify', 'products-auto');

	// Check and refresh Etsy auth token before starting sync
	try {
		const authService = require('../utils/auth-service');
		if (authService.isTokenExpired()) {
			logger.info('Auth token expired, attempting to refresh before starting sync');
			await authService.refreshToken();
			logger.info('Auth token refreshed successfully');
		} else {
			logger.info('Auth token valid, proceeding with sync');
		}
	} catch (authError) {
		logger.error('Failed to refresh auth token before sync', {
			error: authError.message,
			stack: authError.stack,
		});
		// Continue anyway, as we'll handle the auth error in the sync process
	}

	try {
		logger.info('Starting automatic Etsy product sync...', { syncId: etsySyncId });
		// Initialize status for this specific sync operation if your functions expect it
		initializeSyncStatus(etsySyncId, 'etsy', 'products-auto');
		await syncEtsyProducts(etsySyncId, null); // Pass null for req as it's a background task
		logger.info('Automatic Etsy product sync completed.', { syncId: etsySyncId });
	} catch (error) {
		logger.error('Error during automatic Etsy product sync:', {
			syncId: etsySyncId,
			errorMessage: error.message,
			stack: error.stack,
		});
		// Ensure sync status is marked as complete with error for Etsy sync
		completeSyncStatus(etsySyncId, {}, error);
	}

	// Optional: Add a delay here if needed before starting Shopify sync
	// await new Promise(resolve => setTimeout(resolve, 60000)); // e.g., 1 minute delay

	try {
		logger.info('Starting automatic Shopify product sync...', { syncId: shopifySyncId });
		// Initialize status for this specific sync operation
		initializeSyncStatus(shopifySyncId, 'shopify', 'products-auto');
		await syncShopifyProducts(shopifySyncId, null); // Pass null for req
		logger.info('Automatic Shopify product sync completed.', { syncId: shopifySyncId });
	} catch (error) {
		logger.error('Error during automatic Shopify product sync:', {
			syncId: shopifySyncId,
			errorMessage: error.message,
			stack: error.stack,
		});
		// Ensure sync status is marked as complete with error for Shopify sync
		completeSyncStatus(shopifySyncId, {}, error);
	}

	// Note: Order syncing (syncEtsyOrders, syncShopifyOrders) is not included here yet
	// as they are currently structured as route handlers and would need refactoring
	// to be called directly by a background scheduler without an HTTP request/response context.

	logger.info('performFullSync completed.');
}

/**
 * Route to check the status of a sync operation
 * Returns the current status of the sync with the specified ID
 * @route GET /sync/status/:syncId
 * @param {string} req.params.syncId - The unique ID of the sync operation to check
 * @returns {Object} JSON object with the current sync status
 */
router.get('/status/:syncId', (req, res) => {
	const syncId = req.params.syncId;
	let status = syncStatus.get(syncId);

	if (!status && syncStatus.size === 0) {
		return res.status(404).json({ error: 'No ongoing sync for this syncId.' });
	} else if (!status) {
		status = syncStatus.entries().next().value[1]; // Get the first status object if no syncId is provided
	}
	res.json(status);

	// Clean up old status objects after 1 minutes
	if (status.complete) {
		setTimeout(() => {
			syncStatus.delete(syncId);
		}, 60 * 1000);
	}
});

// Export the router as the default export
module.exports = router;

// Also attach the utility functions as properties of the router
router.syncEtsyProducts = syncEtsyProducts;
router.syncShopifyProducts = syncShopifyProducts;
router.syncEtsyOrders = syncEtsyOrders;
router.syncShopifyOrders = syncShopifyOrders;
router.performFullSync = performFullSync;
router.initializeSyncStatus = initializeSyncStatus;
router.updateSyncStatus = updateSyncStatus;
router.completeSyncStatus = completeSyncStatus;
router.validateSyncId = validateSyncId;
