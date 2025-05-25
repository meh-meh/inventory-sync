// TODO: Refactor this file to separate concerns and improve readability
// TODO: Lock buttons until sync is complete
// TODO: Ongoing syncs should live update like the other syncs

/**
 * Marketplace synchronization routes and functions
 * Handles syncing products and orders between Etsy, Shopify, and internal inventory
 * @module routes/sync
 */
const express = require('express');
const router = express.Router();
const { Product, Order, Settings } = require('../models');
const { logger } = require('../utils/logger'); // Destructure logger from the imported module

const {
	validateSyncId,
	initializeSyncStatus,
	updateSyncStatus,
	completeSyncStatus,
	getOngoingAutoSyncs,
	getSyncStatus, // Add getSyncStatus here
} = require('../utils/sync-status-manager');
const {
	syncEtsyProducts: syncEtsyProductsService,
	syncEtsyOrders: syncEtsyOrdersService,
} = require('../services/etsy-sync-service');
const {
	syncShopifyProducts: syncShopifyProductsService,
	syncShopifyOrders: syncShopifyOrdersService,
} = require('../services/shopify-sync-service');

/**
 * Concurrency settings for parallel API page fetches.
 * These do NOT override the global Etsy API concurrency pool, which is always enforced.
 * Tune these for performance as needed.
 */

/**
 * Validates and processes a syncId from request parameters
 * @param {string} requestSyncId - The sync ID from request parameters
 * @param {string} marketplace - The marketplace (etsy or shopify)
 * @param {string} syncType - The type of sync (products, orders, etc.)
 * @returns {string} A validated syncId
 */
// function validateSyncId(requestSyncId, marketplace, syncType) { // Moved to sync-status-manager.js
// 	if (requestSyncId) {
// 		// Validate existing syncId format (allow old format for backward compatibility)
// 		return requestSyncId;
// 	}

// 	// Generate new standardized syncId
// 	return `${marketplace.toLowerCase()}-${syncType.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
// }

/**
 * Initializes sync status tracking for a new sync operation
 * @param {string} syncId - The unique ID for this sync operation
 * @param {string} marketplace - The marketplace this sync is for (etsy or shopify)
 * @param {string} syncType - The type of sync operation (products, orders, etc.)
 * @returns {Object} The initialized status object
 */
// function initializeSyncStatus(syncId, marketplace, syncType) { // Moved to sync-status-manager.js
// 	const status = {
// 		syncId,
// 		marketplace,
// 		syncType,
// 		syncCount: 0,
// 		processedCount: 0,
// 		totalCount: 0,
// 		counts: {},
// 		currentPhase: `Initializing ${marketplace} ${syncType} sync`,
// 		removedCount: 0,
// 		progress: 5, // Start with 5% to show something is happening
// 		complete: false,
// 		error: null,
// 		startTime: Date.now(),
// 		lastUpdated: Date.now(),
// 	};

// 	syncStatus.set(syncId, status);
// 	logger.info(`Initialized sync status for ${syncId}`, { syncId, marketplace, syncType });
// 	return status;
// }

/**
 * Updates the status of a sync operation
 * @param {string} syncId - The sync ID to update
 * @param {Object} updates - The properties to update
 * @returns {Object|null} The updated status or null if not found
 */
// function updateSyncStatus(syncId, updates) { // Moved to sync-status-manager.js
// 	const status = syncStatus.get(syncId);
// 	if (!status) {
// 		logger.warn(`Attempted to update non-existent sync status: ${syncId}`);
// 		return null;
// 	}

// 	Object.assign(status, updates, { lastUpdated: Date.now() });
// 	syncStatus.set(syncId, status);
// 	return status;
// }

router.get('/secretroute', async (req, res) => {
	// This is a secret route for testing purposes only
	// In a real application, you would not expose this endpoint like this
	const syncId = validateSyncId(req.query.syncId, 'dummy', 'data'); // Use the imported function
	initializeSyncStatus(syncId, 'dummy', 'data'); // Use the imported function

	const status = updateSyncStatus(syncId, {
		// Use the imported function
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
// function completeSyncStatus(syncId, finalUpdates = {}, error = null) { // Moved to sync-status-manager.js
// 	const status = syncStatus.get(syncId);
// 	if (!status) {
// 		logger.warn(`Attempted to complete non-existent sync status: ${syncId}`);
// 		return;
// 	}

// 	const updates = {
// 		...finalUpdates,
// 		complete: true,
// 		progress: 100,
// 		currentPhase: error ? 'Failed' : 'Complete',
// 		endTime: Date.now(),
// 		duration: Date.now() - status.startTime,
// 	};

// 	if (error) {
// 		updates.error = typeof error === 'string' ? error : error.message;
// 		logger.error(`Sync ${syncId} completed with error: ${updates.error}`);
// 	} else {
// 		logger.info(`Sync ${syncId} completed successfully in ${updates.duration}ms`);
// 	}

// 	Object.assign(status, updates);
// 	syncStatus.set(syncId, status);

// 	// Schedule status cleanup after retention period
// 	setTimeout(() => {
// 		if (syncStatus.has(syncId)) {
// 			logger.debug(`Cleaning up sync status for ${syncId} after retention period`);
// 			syncStatus.delete(syncId);
// 		}
// 	}, SYNC_STATUS_RETENTION_MS);
// }

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
			Product.countDocuments().maxTimeMS(10000),
			Product.countDocuments({ 'etsy_data.listing_id': { $exists: true } }).maxTimeMS(10000),
			Product.countDocuments({ 'shopify_data.product_id': { $exists: true } }).maxTimeMS(
				10000
			),
			// Find latest product sync time (Etsy)
			Product.findOne({ 'etsy_data.last_synced': { $exists: true } })
				.sort({ 'etsy_data.last_synced': -1 })
				.select('etsy_data.last_synced')
				.maxTimeMS(10000)
				.lean(), // Use lean for performance
			// Find latest product sync time (Shopify)
			Product.findOne({ 'shopify_data.last_synced': { $exists: true } })
				.sort({ 'shopify_data.last_synced': -1 })
				.select('shopify_data.last_synced')
				.maxTimeMS(10000)
				.lean(), // Use lean for performance
			// Find latest order sync time (Etsy) - using updatedAt
			Order.findOne({ marketplace: 'etsy', updatedAt: { $exists: true } })
				.sort({ updatedAt: -1 })
				.select('updatedAt')
				.maxTimeMS(10000)
				.lean(),
			// Find latest order sync time (Shopify) - using updatedAt
			Order.findOne({ marketplace: 'shopify', updatedAt: { $exists: true } })
				.sort({ updatedAt: -1 })
				.select('updatedAt')
				.maxTimeMS(10000)
				.lean(),
		]);

		const ongoingAutoSyncs = getOngoingAutoSyncs(); // Use the imported function
		logger.info('Ongoing automatic syncs:', ongoingAutoSyncs);

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
			ongoingAutoSyncs: ongoingAutoSyncs,
		});
	} catch (error) {
		logger.error('Error fetching sync dashboard data:', error);
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
			ongoingAutoSyncs: [],
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
// async function fetchAllListings(shop_id, syncId) { // Moved to etsy-sync-service.js
// 	const startTime = performance.now();
// 	const listingCounts = {
// 		active: 0,
// 		draft: 0,
// 		expired: 0,
// 		inactive: 0,
// 		sold_out: 0,
// 	};
// 	const allListings = [];
// 	// Note: CONCURRENCY here controls how many parallel jobs (e.g., pages) this sync logic will attempt to process at once.
// 	// The global Etsy API concurrency limit is enforced by etsy-request-pool.js and will always keep us within Etsy's rate limits.
// 	// You can tune this value for performance, but the global pool is the final safeguard.

// 	// Update status if syncId is provided
// 	const updateStatus = (progress, currentPhase = '') => {
// 		if (syncId) {
// 			const status = syncStatus.get(syncId);
// 			if (status) {
// 				status.counts = { ...listingCounts };
// 				status.progress = progress;
// 				// Calculate total items processed so far
// 				status.syncCount = Object.values(listingCounts).reduce(
// 					(sum, count) => sum + count,
// 					0
// 				);
// 				if (currentPhase) {
// 					status.currentPhase = currentPhase;
// 				}
// 				syncStatus.set(syncId, status);
// 				console.log(`Updated status for ${syncId}:`, status);
// 			}
// 		}
// 	};

// 	// Fetch active listings (includes draft and sold out)
// 	const limit = 100;
// 	const tokenData = JSON.parse(process.env.TOKEN_DATA);

// 	// Get selected shipping profiles to filter by
// 	const selectedShippingProfiles = process.env.SYNC_SHIPPING_PROFILES
// 		? JSON.parse(process.env.SYNC_SHIPPING_PROFILES)
// 		: [];

// 	const hasShippingProfileFilter = selectedShippingProfiles.length > 0;
// 	logger.info('Fetching listings with shipping profile filter', {
// 		filterEnabled: hasShippingProfileFilter,
// 		selectedProfiles: selectedShippingProfiles,
// 	});

// 	var headers = new Headers();

// 	const states = ['active', 'draft', 'expired', 'inactive', 'sold_out'];

// 	headers.append('x-api-key', process.env.ETSY_API_KEY);
// 	headers.append('Authorization', `Bearer ${tokenData.access_token}`);

// 	logger.info('Fetching all listings with complete data...');
// 	updateStatus(10); // Initial status update

// 	// Parallelize per state
// 	for (const state of states) {
// 		let offset = 0;
// 		let urlencoded = new URLSearchParams();
// 		urlencoded.append('state', state);
// 		urlencoded.append('limit', limit);
// 		urlencoded.append('offset', offset);
// 		urlencoded.append('includes', 'Shipping,Images,Shop,User,Translations,Inventory,Videos');
// 		let requestOptions = {
// 			method: 'GET',
// 			headers: headers,
// 			redirect: 'follow',
// 		};
// 		const fetchUrl = `https://openapi.etsy.com/v3/application/shops/${shop_id}/listings?${urlencoded.toString()}`;
// 		const firstResp = await etsyRequest(() => etsyFetch(fetchUrl, requestOptions), {
// 			endpoint: '/listings',
// 			method: 'GET',
// 			state,
// 			offset: 0,
// 			syncId,
// 		});
// 		if (!firstResp.ok) {
// 			const errorText = await firstResp.text();
// 			logger.error('Error fetching listings:', {
// 				status: firstResp.status,
// 				statusText: firstResp.statusText,
// 				details: errorText,
// 			});
// 			throw new Error(
// 				`Failed to fetch listings: ${firstResp.status} ${firstResp.statusText}`
// 			);
// 		}
// 		const firstData = await firstResp.json();
// 		const firstListings = firstData.results || [];
// 		// Filter listings by shipping profile if filter is enabled
// 		const filteredFirstListings = hasShippingProfileFilter
// 			? firstListings.filter(listing =>
// 					selectedShippingProfiles.includes(listing.shipping_profile_id?.toString())
// 				)
// 			: firstListings;
// 		listingCounts[state] = filteredFirstListings.length;
// 		allListings.push(...filteredFirstListings);
// 		const totalCount =
// 			typeof firstData.count === 'number' && isFinite(firstData.count) && firstData.count > 0
// 				? firstData.count
// 				: firstListings.length;
// 		const totalPages = Math.ceil(totalCount / limit);
// 		if (totalPages > 1) {
// 			// Prepare offsets for remaining pages
// 			const offsets = [];
// 			for (let i = 1; i < totalPages; i++) {
// 				offsets.push(i * limit);
// 			}
// 			async function fetchPage(offset) {
// 				let retries = 0;
// 				while (retries < 5) {
// 					urlencoded.set('offset', offset);
// 					urlencoded.set('state', state);
// 					const pageUrl = `https://openapi.etsy.com/v3/application/shops/${shop_id}/listings?${urlencoded.toString()}`;
// 					try {
// 						const resp = await etsyRequest(() => etsyFetch(pageUrl, requestOptions), {
// 							endpoint: '/listings',
// 							method: 'GET',
// 							state,
// 							offset,
// 							syncId,
// 						});
// 						if (!resp.ok) {
// 							const errorText = await resp.text();
// 							logger.error('Error fetching listings:', {
// 								status: resp.status,
// 								error: errorText,
// 							});
// 							throw new Error(
// 								`Failed to fetch listings: ${resp.status} ${resp.statusText}`
// 							);
// 						}
// 						const data = await resp.json();
// 						const listings = data.results || [];
// 						return hasShippingProfileFilter
// 							? listings.filter(listing =>
// 									selectedShippingProfiles.includes(
// 										listing.shipping_profile_id?.toString()
// 									)
// 								)
// 							: listings;
// 					} catch (err) {
// 						logger.error('Error fetching listings page', {
// 							offset,
// 							state,
// 							error: err.message,
// 						});
// 						await new Promise(r => setTimeout(r, 1000 * Math.pow(2, retries)));
// 						retries++;
// 					}
// 				}
// 				logger.error('Failed to fetch listings after retries', { offset, state });
// 				return [];
// 			}
// 			let idx = 0;
// 			const results = [];
// 			async function worker() {
// 				while (idx < offsets.length) {
// 					const myIdx = idx++;
// 					const offset = offsets[myIdx];
// 					const res = await fetchPage(offset);
// 					listingCounts[state] += res.length;
// 					results.push(...res);
// 				}
// 			}
// 			await Promise.all(
// 				Array(PRODUCT_SYNC_CONCURRENCY)
// 					.fill(0)
// 					.map(() => worker())
// 			);
// 			allListings.push(...results);
// 		}
// 		updateStatus(10 + Math.round((states.indexOf(state) / states.length) * 70));
// 	}
// 	logger.info('Finished fetching all listings', { counts: listingCounts });
// 	updateStatus(30); // Final update after all listings are fetched
// 	const endTime = performance.now();
// 	logger.info(`[Perf] fetchAllListings took ${(endTime - startTime).toFixed(2)}ms`, { syncId });
// 	return { listings: allListings, counts: listingCounts };
// }

/**
 * Helper function to clean up products that don't match selected shipping profiles
 * Removes products with shipping profiles not in the configured allowlist
 * @returns {Promise<Object>} Result object with count of deleted products or abort information
 */
// async function removeProductsWithUnselectedShippingProfiles() { // Moved to etsy-sync-service.js and used internally by syncEtsyProductsService
// 	const startTime = performance.now(); // Defined startTime
// 	const syncId = validateSyncId(null, 'internal', 'cleanup-shipping-profiles');
// 	initializeSyncStatus(syncId, 'internal', 'cleanup-shipping-profiles');
// 	updateSyncStatus(syncId, { currentPhase: 'Starting cleanup' });

// 	try {
// 		// Get selected shipping profiles from environment variables
// 		const selectedShippingProfiles = process.env.SYNC_SHIPPING_PROFILES
// 			? JSON.parse(process.env.SYNC_SHIPPING_PROFILES)
// 			: [];

// 		logger.info('Cleaning up products with non-matching shipping profiles', {
// 			selectedProfiles: selectedShippingProfiles,
// 		});

// 		// If no shipping profiles are selected, don't delete anything
// 		if (!selectedShippingProfiles || selectedShippingProfiles.length === 0) {
// 			logger.info('No shipping profiles selected, skipping cleanup');
// 			return { deletedCount: 0 };
// 		}

// 		// Safety check: If we're about to delete more than 50% of products, abort
// 		const totalEtsyProducts = await Product.countDocuments({
// 			'etsy_data.listing_id': { $exists: true },
// 		});

// 		// Convert all selected profile IDs to strings explicitly to ensure consistency
// 		const selectedProfilesAsStrings = selectedShippingProfiles.map(id => String(id));

// 		// Simplified query - no type conversion needed since shipping_profile_id is already a String
// 		const query = {
// 			'etsy_data.listing_id': { $exists: true },
// 			$or: [
// 				{ 'etsy_data.shipping_profile_id': { $exists: false } },
// 				{ 'etsy_data.shipping_profile_id': null },
// 				{ 'etsy_data.shipping_profile_id': '' },
// 				{
// 					'etsy_data.shipping_profile_id': {
// 						$exists: true,
// 						$nin: selectedProfilesAsStrings,
// 					},
// 				},
// 			],
// 		};

// 		const queryStartTime = performance.now();
// 		const productsToDelete = await Product.countDocuments(query);
// 		const queryEndTime = performance.now();
// 		logger.info(
// 			`[Perf] removeProductsWithUnselectedShippingProfiles count query took ${(queryEndTime - queryStartTime).toFixed(2)}ms`
// 		);

// 		logger.info('Products cleanup assessment', {
// 			totalEtsyProducts,
// 			productsToDelete,
// 			percentageToDelete:
// 				totalEtsyProducts > 0
// 					? ((productsToDelete / totalEtsyProducts) * 100).toFixed(2) + '%'
// 					: '0%',
// 		});

// 		// Safety check
// 		if (
// 			productsToDelete > totalEtsyProducts * 0.5 ||
// 			(totalEtsyProducts > 0 && productsToDelete === totalEtsyProducts)
// 		) {
// 			logger.warn(
// 				`Safety check triggered: Would remove ${productsToDelete} out of ${totalEtsyProducts} products. Skipping automated cleanup.`
// 			);
// 			return {
// 				deletedCount: 0,
// 				aborted: true,
// 				reason: 'Safety check triggered - too many products would be deleted',
// 			};
// 		}

// 		const deleteStartTime = performance.now();
// 		// Direct approach: execute the delete operation with the same query
// 		const result = await Product.deleteMany(query);
// 		const deleteEndTime = performance.now();
// 		logger.info(
// 			`[Perf] removeProductsWithUnselectedShippingProfiles deleteMany took ${(deleteEndTime - deleteStartTime).toFixed(2)}ms`,
// 			{ deletedCount: result.deletedCount }
// 		);

// 		const endTime = performance.now();
// 		logger.info(
// 			`[Perf] removeProductsWithUnselectedShippingProfiles total took ${(endTime - startTime).toFixed(2)}ms`,
// 			{ syncId }
// 		);
// 		return result;
// 	} catch (error) {
// 		logger.error('Error removing products with unselected shipping profiles:', {
// 			error: error.message,
// 		});
// 		throw error;
// 	}
// }

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
		syncEtsyProductsService(syncId, req, req.query.includeNonActive === 'true').catch(error => {
			// Called service function
			logger.error('Error in background Etsy sync:', { error: error.message, syncId });

			// Update sync status with error
			// completeSyncStatus is preferred over updateSyncStatus for final states
			completeSyncStatus(syncId, { currentPhase: 'Failed' }, error);
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
			return res.status(500).json({ error: 'Failed to start sync' });
		}
		req.flash('error', 'Failed to start sync. Please try again.');
		res.redirect('/sync');
	}
});

router.get('/sync-shopify', async (req, res) => {
	try {
		const syncId = validateSyncId(req.query.syncId, 'shopify', 'products');
		console.log(`Starting Shopify sync with syncId: ${syncId}`);
		initializeSyncStatus(syncId, 'shopify', 'products');

		syncShopifyProductsService(syncId, req).catch(error => {
			logger.error('Error in background Shopify sync:', { error: error.message, syncId });
			completeSyncStatus(syncId, { currentPhase: 'Failed' }, error);
		});

		if (req.xhr || req.headers.accept?.includes('application/json')) {
			res.json({
				success: true,
				message: 'Shopify product sync started successfully',
				syncId,
			});
		} else {
			if (!req.query.syncId) {
				return res.redirect(`/sync/sync-shopify?syncId=${syncId}`);
			}
			res.redirect('/sync');
		}
	} catch (error) {
		logger.error('Error starting Shopify product sync:', { error: error.message });
		if (req.xhr || req.headers.accept?.includes('application/json')) {
			return res.status(500).json({ error: 'Failed to start Shopify product sync' });
		}
		req.flash('error', 'Failed to start Shopify product sync. Please try again.');
		res.redirect('/sync');
	}
});

/**
 * Route to initiate an order synchronization for a specified marketplace (Etsy or Shopify)
 * Starts the sync process in the background and returns immediately
 *
 * @route POST /sync/sync-orders
 * @param {string} req.body.marketplace - The marketplace to sync (etsy or shopify)
 * @param {string} [req.query.syncId] - Optional sync ID for tracking progress
 * @returns {Object} JSON response with message and syncId
 */
router.post('/sync-orders', async (req, res) => {
	const { marketplace } = req.body;
	const syncId = validateSyncId(req.query.syncId, marketplace, 'orders');

	if (!marketplace) {
		return res.status(400).json({ error: 'Marketplace is required' });
	}

	logger.info(`Order sync requested for ${marketplace}`, { syncId });
	res.json({ message: `Order sync started for ${marketplace}.`, syncId }); // Respond immediately

	try {
		if (marketplace === 'etsy') {
			await syncEtsyOrdersService(syncId);
		} else if (marketplace === 'shopify') {
			await syncShopifyOrdersService(syncId);
		} else {
			logger.warn(`Unsupported marketplace for order sync: ${marketplace}`, { syncId }); // Corrected template literal
			completeSyncStatus(
				syncId,
				{ currentPhase: 'Unsupported marketplace' },
				new Error('Unsupported marketplace')
			);
		}
	} catch (error) {
		logger.error(`Error during ${marketplace} order sync process:`, {
			syncId,
			error: error.message,
			stack: error.stack,
		}); // Corrected template literal
		// The service function should handle its own completeSyncStatus on error
	}
});

/**
 * Synchronizes Shopify orders with the internal database
 * Fetches order data from Shopify using GraphQL API, processes it, and updates the database
 *
 * @param {string|Object} req - Either the syncId string or the Express request object with syncId query parameter
 * @param {Object} [res] - Express response object if called from a route handler, optional if called programmatically
 * @returns {Promise<void>} - Resolves when sync is complete, with response sent if res is provided
 * @throws {Error} - If there's an error during the synchronization process
 */
// async function syncShopifyOrders(req, res) {
// 	const syncId = validateSyncId(req?.query?.syncId || req, 'shopify', 'orders');
// 	const BATCH_SIZE = 100; // Shopify GraphQL API limit for orders
// 	const ORDER_SYNC_DAYS = parseInt(process.env.ORDER_SYNC_DAYS || '90', 10);
// 	const overallStartTime = performance.now();
// 	let newOrders = 0;
// 	let updatedOrders = 0;

// 	// Initialize sync status
// 	initializeSyncStatus(syncId, 'shopify', 'orders');

// 	try {
// 		logger.info('Starting Shopify order sync using GraphQL', {
// 			syncId,
// 			orderSyncDays: ORDER_SYNC_DAYS,
// 		});
// 		updateSyncStatus(syncId, { currentPhase: 'Initializing Shopify order sync', progress: 5 });

// 		// Check if Shopify credentials are available
// 		if (!process.env.SHOPIFY_SHOP_NAME || !process.env.SHOPIFY_ACCESS_TOKEN) {
// 			throw new Error('Missing Shopify credentials in environment variables');
// 		}

// 		// Initialize Shopify client with explicit options
// 		const shopify = new Shopify({
// 			shopName: process.env.SHOPIFY_SHOP_NAME,
// 			accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
// 			apiVersion: '2023-10', // Set explicit API version
// 			timeout: 60000, // 60 second timeout
// 			autoLimit: true, // Automatically handle rate limits
// 		});

// 		// Array to store all orders
// 		let allShopifyOrders = [];

// 		// Calculate timestamp for specified days ago
// 		const date = new Date();
// 		date.setDate(date.getDate() - ORDER_SYNC_DAYS);
// 		const formattedDate = date.toISOString();
// 		logger.info(`Fetching Shopify orders created after: ${formattedDate}`, { syncId });

// 		// Ship date field is fulfillments.createdAt
// 		// GraphQL fragment with fields to retrieve for each order
// 		const orderFieldsFragment = `{
//             pageInfo {
//                 hasNextPage
//                 endCursor
//             }
//             nodes {
//                 id
//                 name
//                 email
//                 phone
//                 totalPriceSet {
//                     shopMoney {
//                         amount
//                         currencyCode
//                     }
//                 }
//                 displayFinancialStatus
//                 displayFulfillmentStatus
//                 createdAt
//                 processedAt
//                 fulfillments(first: 5) {
//                     id
// 					createdAt
//                     deliveredAt
//                     status
//                     trackingInfo(first: 5) {
//                         company
//                         number
//                     url
//                     }
//                 }
//                 customer {
//                     id
//                     firstName
//                     lastName
//                     email
//                 }
//                 lineItems(first: 250) {
//                     nodes {
//                         id
//                         title
//                         quantity
//                         variant {
//                             id
//                             sku
//                             product {
//                                 id
//                             }
//                         }
//                         requiresShipping
//                     }
//                 }
//             }
//         }`;

// 		// Initial query for first batch of orders
// 		let query = `{
//             orders(first: ${BATCH_SIZE}, query: "created_at:>=${formattedDate}") ${orderFieldsFragment}
//         }`;

// 		// Execute initial query
// 		updateSyncStatus(syncId, { currentPhase: 'Fetching first batch of orders', progress: 10 });
// 		let result = await shopify.graphql(query);

// 		if (!result || !result.orders || !result.orders.nodes) {
// 			logger.error('Error fetching orders from Shopify: Unexpected response structure', {
// 				syncId,
// 			});
// 			throw new Error('Failed to fetch orders from Shopify: Invalid response structure');
// 		}

// 		// Process first batch
// 		logger.info(`Fetched initial batch of ${result.orders.nodes.length} orders from Shopify`, {
// 			syncId,
// 		});
// 		allShopifyOrders.push(...result.orders.nodes);

// 		// Variables for pagination and progress tracking
// 		let hasNextPage = result.orders.pageInfo.hasNextPage;
// 		let endCursor = result.orders.pageInfo.endCursor;
// 		let daysRunningTotal = 0;
// 		let batchCount = 1;

// 		// Calculate approximate timespan of first batch for progress estimation
// 		if (result.orders.nodes.length > 1) {
// 			const firstOrderDate = new Date(result.orders.nodes[0].createdAt);
// 			const lastOrderDate = new Date(
// 				result.orders.nodes[result.orders.nodes.length - 1].createdAt
// 			);
// 			daysRunningTotal = Math.abs(firstOrderDate - lastOrderDate) / (1000 * 60 * 60 * 24);
// 		}

// 		// Fetch remaining pages
// 		while (hasNextPage) {
// 			batchCount++;
// 			updateSyncStatus(syncId, {
// 				currentPhase: `Fetching order batch #${batchCount}`,
// 				progress: 10 + Math.min(60, Math.round((daysRunningTotal / ORDER_SYNC_DAYS) * 60)),
// 			});

// 			// Query for next page using cursor
// 			query = `{
//                 orders(first: ${BATCH_SIZE}, after: "${endCursor}", query: "created_at:>=${formattedDate}") ${orderFieldsFragment}
//             }`;

// 			try {
// 				// Add delay to avoid rate limiting
// 				await shopifyHelpers.sleep(500);

// 				// Execute query for next page
// 				result = await shopify.graphql(query);

// 				if (!result || !result.orders || !result.orders.nodes) {
// 					logger.warn(`Invalid response for batch #${batchCount}, skipping`, { syncId });
// 					break;
// 				}

// 				const tempOrderCount = result.orders.nodes.length;

// 				if (tempOrderCount > 0) {
// 					// Add orders to our collection
// 					allShopifyOrders.push(...result.orders.nodes);

// 					// Update pagination variables
// 					hasNextPage = result.orders.pageInfo.hasNextPage;
// 					endCursor = result.orders.pageInfo.endCursor;

// 					// Calculate date span for progress estimation
// 					if (tempOrderCount > 1) {
// 						const firstOrderDate = new Date(result.orders.nodes[0].createdAt);
// 						const lastOrderDate = new Date(
// 							result.orders.nodes[result.orders.nodes.length - 1].createdAt
// 						);
// 						const batchDays =
// 							Math.abs(firstOrderDate - lastOrderDate) / (1000 * 60 * 60 * 24);
// 						daysRunningTotal += batchDays;
// 					}

// 					// Estimate total orders based on current rate and remaining days
// 					const averageOrdersPerDay =
// 						allShopifyOrders.length / Math.max(daysRunningTotal, 1);
// 					const daysRemaining = Math.max(0, ORDER_SYNC_DAYS - daysRunningTotal);
// 					const estimatedTotal = Math.ceil(
// 						averageOrdersPerDay * daysRemaining + allShopifyOrders.length
// 					);

// 					logger.info(
// 						`Fetched batch #${batchCount} with ${tempOrderCount} orders, total so far: ${allShopifyOrders.length}`,
// 						{
// 							syncId,
// 							estimatedTotal,
// 							daysProcessed: daysRunningTotal,
// 							averageOrdersPerDay,
// 						}
// 					);

// 					// Update sync status with current progress
// 					updateSyncStatus(syncId, {
// 						syncCount: allShopifyOrders.length,
// 						processedCount: allShopifyOrders.length,
// 						totalCount: estimatedTotal,
// 						progress:
// 							10 +
// 							Math.min(60, Math.round((daysRunningTotal / ORDER_SYNC_DAYS) * 60)),
// 					});
// 				} else {
// 					// No orders in this batch, end pagination
// 					hasNextPage = false;
// 					logger.info(`No orders in batch #${batchCount}, ending pagination`, { syncId });
// 				}
// 			} catch (error) {
// 				// Log error but try to continue with orders collected so far
// 				logger.error(`Error fetching batch #${batchCount}`, {
// 					syncId,
// 					error: error.message,
// 				});

// 				// Stop pagination if we've had an error
// 				hasNextPage = false;

// 				// Only throw if we haven't fetched any orders yet
// 				if (allShopifyOrders.length === 0) {
// 					throw new Error(`Failed to fetch orders: ${error.message}`);
// 				}
// 			}
// 		}

// 		// Final count of fetched orders
// 		const orderCount = allShopifyOrders.length;
// 		logger.info(`Completed fetching ${orderCount} Shopify orders`, { syncId });

// 		// Process orders for database updates
// 		if (orderCount > 0) {
// 			updateSyncStatus(syncId, {
// 				currentPhase: 'Processing orders for database update',
// 				progress: 70,
// 				syncCount: orderCount,
// 				totalCount: orderCount,
// 			});

// 			// Lookup existing orders to determine new vs updated
// 			const orderIds = allShopifyOrders.map(o => `shopify-${o.id.split('/').pop()}`);
// 			logger.info(`Looking up ${orderIds.length} orders in database`, { syncId });

// 			const existingOrders = await Order.find({
// 				order_id: { $in: orderIds },
// 				marketplace: 'shopify',
// 			}).lean();

// 			const existingOrderMap = new Map(existingOrders.map(o => [o.order_id, o]));
// 			logger.info(`Found ${existingOrders.length} existing Shopify orders in database`, {
// 				syncId,
// 			});

// 			// Prepare database operations
// 			const bulkOps = [];

// 			// Process all orders
// 			for (const [i, shopifyOrder] of allShopifyOrders.entries()) {
// 				try {
// 					// Extract clean ID from GraphQL ID (remove gid://shopify/Order/ prefix)
// 					const shopifyId = shopifyOrder.id.split('/').pop();
// 					const orderId = `shopify-${shopifyId}`;
// 					const existing = existingOrderMap.get(orderId);

// 					// Extract line items
// 					const items = (shopifyOrder.lineItems?.nodes || []).map(item => {
// 						const variantId = item.variant?.id?.split('/').pop();
// 						const productId = item.variant?.product?.id?.split('/').pop();
// 						return {
// 							marketplace: 'shopify',
// 							line_item_id: item.id?.split('/').pop(),
// 							product_id: productId,
// 							variant_id: variantId,
// 							sku: item.variant?.sku || `SHOPIFY-${productId}-${variantId}`,
// 							quantity: item.quantity,
// 							is_digital: item.requiresShipping === false,
// 							title: item.title,
// 						};
// 					});

// 					// Prepare update operation
// 					const update = {
// 						$set: {
// 							order_id: orderId,
// 							marketplace: 'shopify',
// 							shopify_order_number: shopifyOrder.name,
// 							order_date: new Date(shopifyOrder.createdAt),
// 							buyer_name:
// 								`${shopifyOrder.customer?.firstName || ''} ${shopifyOrder.customer?.lastName || ''}`.trim(),
// 							receipt_id: orderId,
// 							items,
// 							shopify_order_data: shopifyOrder,
// 							financial_status: shopifyOrder.displayFinancialStatus,
// 							fulfillment_status: shopifyOrder.displayFulfillmentStatus.toLowerCase(),
// 							status:
// 								shopifyOrder.displayFulfillmentStatus.toLowerCase() === 'fulfilled'
// 									? 'shipped'
// 									: 'unshipped', // Status updated here
// 							last_updated: new Date(),
// 							shipped_date: shopifyOrder.fulfillments?.[0]?.createdAt
// 								? new Date(shopifyOrder.fulfillments?.[0]?.createdAt)
// 								: null,
// 						},
// 					};

// 					// Add to bulk operations
// 					bulkOps.push({
// 						updateOne: {
// 							filter: { order_id: orderId, marketplace: 'shopify' },
// 							update,
// 							upsert: true,
// 						},
// 					});

// 					// Track if new or updated
// 					if (existing) {
// 						updatedOrders++;
// 					} else {
// 						newOrders++;
// 					}

// 					// Update progress periodically
// 					if (i % 50 === 0 || i === allShopifyOrders.length - 1) {
// 						updateSyncStatus(syncId, {
// 							currentPhase: `Processing orders (${i + 1} of ${allShopifyOrders.length})`,
// 							progress: 70 + Math.round(((i + 1) / allShopifyOrders.length) * 20),
// 							processedCount: i + 1,
// 							totalCount: allShopifyOrders.length,
// 						});
// 					}
// 				} catch (error) {
// 					// Log error but continue with next order
// 					logger.error(`Error processing order ${shopifyOrder.id || 'unknown'}`, {
// 						syncId,
// 						error: error.message,
// 						order: shopifyOrder.id || 'unknown',
// 					});
// 				}
// 			}

// 			// Perform database operations
// 			if (bulkOps.length > 0) {
// 				updateSyncStatus(syncId, {
// 					currentPhase: 'Writing to database',
// 					progress: 95,
// 					processedCount: allShopifyOrders.length,
// 				});

// 				logger.info(`Writing ${bulkOps.length} order operations to database`, { syncId });

// 				// Execute bulk write operation
// 				const result = await Order.bulkWrite(bulkOps, { ordered: false });

// 				// Log results
// 				logger.info('Database write complete', {
// 					syncId,
// 					upserted: result.upsertedCount,
// 					modified: result.modifiedCount,
// 					matched: result.matchedCount,
// 					newOrders,
// 					updatedOrders,
// 				});

// 				// Update sync status with counts
// 				updateSyncStatus(syncId, {
// 					counts: {
// 						added: result.upsertedCount || 0,
// 						updated: result.modifiedCount || 0,
// 					},
// 				});
// 			} else {
// 				logger.info('No orders to write to database', { syncId });
// 			}
// 		} else {
// 			logger.info('No Shopify orders found to process', { syncId });
// 		}

// 		// Mark sync as complete
// 		completeSyncStatus(syncId);

// 		// Update last sync time setting
// 		await Settings.setSetting('lastShopifyOrderSync', new Date().toISOString());

// 		// Return response if this was called from an HTTP endpoint
// 		if (res) {
// 			const message = `Successfully synced ${orderCount} Shopify orders (${newOrders || 0} new, ${updatedOrders || 0} updated)`;
// 			logger.info(message, { syncId });

// 			res.json({
// 				success: true,
// 				message,
// 				syncId,
// 			});
// 		}
// 	} catch (error) {
// 		// Handle any errors that occurred during the sync
// 		logger.error('Error syncing Shopify orders:', {
// 			syncId,
// 			error: error.message,
// 			stack: error.stack,
// 		});

// 		// Mark sync as failed
// 		completeSyncStatus(syncId, {}, error);

// 		// Return error response if this was called from an HTTP endpoint
// 		if (res) {
// 			res.status(500).json({
// 				success: false,
// 				error: error.message,
// 			});
// 		}
// 	} finally {
// 		const overallEndTime = performance.now();
// 		logger.info(
// 			`[Perf] Overall syncShopifyOrders took ${(overallEndTime - overallStartTime).toFixed(2)}ms`,
// 			{ syncId }
// 		);
// 	}
//}

/**
 * Route to get the status of a specific sync operation
 * @route GET /sync/status/:syncId
 * @param {string} req.params.syncId - The ID of the sync operation
 * @returns {Object} JSON response with the sync status or 404 if not found
 */
router.get('/status/:syncId', (req, res) => {
	const { syncId } = req.params;
	// Retrieve status using the getSyncStatus function from the manager
	const status = getSyncStatus(syncId); // Use the imported function
	if (status) {
		res.json(status);
	} else {
		res.status(404).json({ error: 'Sync status not found or expired' });
	}
});

module.exports = router;
