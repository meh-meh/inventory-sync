const { logger } = require('../utils/logger');
const { performance } = require('perf_hooks');
const { Product, Order, Settings } = require('../models'); // Added
const { etsyFetch, getShopId } = require('../utils/etsy-helpers'); // Added
const { etsyRequest } = require('../utils/etsy-request-pool'); // Added
const {
	initializeSyncStatus,
	updateSyncStatus,
	completeSyncStatus,
	getSyncStatus,
} = require('../utils/sync-status-manager'); // Removed validateSyncId
const authService = require('../utils/auth-service'); // Added
const API_BASE_URL = process.env.ETSY_API_URL || 'https://openapi.etsy.com/v3'; // Added
const RETRY_DELAY = parseInt(process.env.ETSY_API_RETRY_DELAY, 10) || 1000; // Added RETRY_DELAY

/**
 * Helper function to fetch all Etsy listings in bulk from all listing states
 * Uses the Etsy API to fetch active, draft, expired, inactive, and sold_out listings
 * @param {string} shop_id - The Etsy shop ID to fetch listings for
 * @param {string} syncId - Optional sync ID for tracking progress
 * @param {boolean} includeNonActive - Flag to include non-active listings in the sync (added to match usage)
 * @returns {Promise<Object>} Object containing all fetched listings and counts by status
 */
async function fetchAllListings(shop_id, syncId, includeNonActive = true) {
	// Added includeNonActive parameter
	const startTime = performance.now();
	const listingCounts = {
		active: 0,
		draft: 0,
		expired: 0,
		inactive: 0,
		sold_out: 0,
	};
	const allListings = [];

	const productSyncConcurrency = parseInt(process.env.PRODUCT_SYNC_CONCURRENCY, 10) || 5;

	const updateStatus = (progress, currentPhase = '', counts = null) => {
		if (syncId) {
			const statusUpdate = { progress, currentPhase };
			if (counts) {
				statusUpdate.counts = counts;
			}
			// Calculate total items processed so far if counts are available
			if (counts) {
				statusUpdate.syncCount = Object.values(counts).reduce(
					(sum, count) => sum + count,
					0
				);
			}
			updateSyncStatus(syncId, statusUpdate);
			// console.log(`Updated status for ${syncId}:`, getSyncStatus(syncId)); // For debugging
		}
	};

	const limit = 100;

	const selectedShippingProfiles = process.env.SYNC_SHIPPING_PROFILES
		? JSON.parse(process.env.SYNC_SHIPPING_PROFILES)
		: [];

	const hasShippingProfileFilter = selectedShippingProfiles.length > 0;
	logger.info('Fetching listings with shipping profile filter', {
		filterEnabled: hasShippingProfileFilter,
		selectedProfiles: selectedShippingProfiles,
		syncId,
	});

	var headers = new Headers(); // Standard Headers object

	// Determine which states to fetch based on includeNonActive
	const statesToFetch = includeNonActive
		? ['active', 'draft', 'expired', 'inactive', 'sold_out']
		: ['active']; // Only active if not including non-active

	headers.append('x-api-key', process.env.ETSY_API_KEY);
	// Ensure token is fresh
	const accessToken = authService.getAccessToken();
	if (!accessToken) {
		logger.error('No access token available for fetchAllListings', { syncId });
		throw new Error('Authentication token not available.');
	}
	headers.append('Authorization', `Bearer ${accessToken}`);

	logger.info(`Fetching listings for states: ${statesToFetch.join(', ')}`, { syncId });
	updateStatus(10, 'Preparing to fetch listings', listingCounts);

	// Parallelize per state
	for (const state of statesToFetch) {
		let totalStateListings = 0;

		// Initial fetch to get count for the state
		const initialUrlencoded = new URLSearchParams();
		initialUrlencoded.append('state', state);
		initialUrlencoded.append('limit', 1); // Fetch 1 to get count
		initialUrlencoded.append('offset', 0);
		initialUrlencoded.append(
			'includes',
			'Shipping,Images,Shop,User,Translations,Inventory,Videos'
		); // Keep includes for consistency

		const initialFetchUrl = `${API_BASE_URL}/application/shops/${shop_id}/listings?${initialUrlencoded.toString()}`;
		try {
			const initialResp = await etsyRequest(
				() => etsyFetch(initialFetchUrl, { method: 'GET', headers, redirect: 'follow' }),
				{
					endpoint: '/listings',
					method: 'GET',
					state,
					offset: 0,
					syncId,
				}
			);
			if (!initialResp.ok) {
				const errorText = await initialResp.text();
				logger.error('Error fetching initial listing count for state:', {
					state,
					status: initialResp.status,
					errorText,
					syncId,
				});
				continue; // Skip this state if count fetch fails
			}
			const initialData = await initialResp.json();
			totalStateListings = initialData.count || 0;
			if (totalStateListings === 0) {
				logger.info(`No listings found for state: ${state}`, { syncId });
				listingCounts[state] = 0;
				updateStatus(
					10 +
						Math.round(
							((statesToFetch.indexOf(state) + 1) / statesToFetch.length) * 20
						),
					`Fetched 0 ${state} listings`,
					listingCounts
				);
				continue; // Move to next state
			}
			logger.info(`Total ${totalStateListings} listings found for state: ${state}`, {
				syncId,
			});
		} catch (error) {
			logger.error(`Exception fetching initial listing count for state: ${state}`, {
				error: error.message,
				syncId,
			});
			continue; // Skip this state
		}

		const totalPages = Math.ceil(totalStateListings / limit);
		const pageOffsets = [];
		for (let i = 0; i < totalPages; i++) {
			pageOffsets.push(i * limit);
		}

		async function fetchPage(pageOffset) {
			let retries = 0;
			const MAX_RETRIES_PAGE = 3;
			while (retries < MAX_RETRIES_PAGE) {
				const urlencoded = new URLSearchParams();
				urlencoded.append('state', state);
				urlencoded.append('limit', limit.toString());
				urlencoded.append('offset', pageOffset.toString());
				urlencoded.append(
					'includes',
					'Shipping,Images,Shop,User,Translations,Inventory,Videos'
				);

				const pageUrl = `${API_BASE_URL}/application/shops/${shop_id}/listings?${urlencoded.toString()}`;
				try {
					const resp = await etsyRequest(
						() => etsyFetch(pageUrl, { method: 'GET', headers, redirect: 'follow' }),
						{
							endpoint: '/listings',
							method: 'GET',
							state,
							offset: pageOffset,
							syncId,
						}
					);

					if (!resp.ok) {
						const errorText = await resp.text();
						logger.warn('Error fetching listings page, retrying...', {
							state,
							pageOffset,
							status: resp.status,
							errorText,
							attempt: retries + 1,
							syncId,
						});
						if (resp.status === 429 || resp.status >= 500) {
							// Retry on rate limit or server error
							await new Promise(r =>
								setTimeout(r, RETRY_DELAY * Math.pow(2, retries))
							);
							retries++;
							continue;
						}
						throw new Error(
							`Failed to fetch listings page: ${resp.status} ${errorText.substring(0, 100)}`
						);
					}
					const data = await resp.json();
					const listingsOnPage = data.results || [];

					const filteredPageListings = hasShippingProfileFilter
						? listingsOnPage.filter(listing =>
								selectedShippingProfiles.includes(
									listing.shipping_profile_id?.toString()
								)
							)
						: listingsOnPage;

					return filteredPageListings;
				} catch (err) {
					logger.error('Exception during listings page fetch', {
						state,
						pageOffset,
						error: err.message,
						attempt: retries + 1,
						syncId,
					});
					retries++;
					if (retries < MAX_RETRIES_PAGE) {
						await new Promise(r => setTimeout(r, RETRY_DELAY * Math.pow(2, retries)));
					} else {
						logger.error('Max retries reached for page fetch', {
							state,
							pageOffset,
							syncId,
						});
						return []; // Return empty if max retries reached
					}
				}
			}
			return []; // Should not be reached if retries are handled correctly
		}

		// Concurrently fetch pages for the current state
		const CONCURRENT_PAGE_FETCHES = productSyncConcurrency; // Use the defined concurrency
		const resultsForState = [];
		let currentOffsetIndex = 0;

		const workerPromises = [];
		for (let i = 0; i < CONCURRENT_PAGE_FETCHES; i++) {
			workerPromises.push(
				(async () => {
					while (currentOffsetIndex < pageOffsets.length) {
						const myOffsetIndex = currentOffsetIndex++;
						if (myOffsetIndex >= pageOffsets.length) break; // All offsets taken

						const offsetToFetch = pageOffsets[myOffsetIndex];
						const fetchedPageListings = await fetchPage(offsetToFetch);
						resultsForState.push(...fetchedPageListings);

						// Update progress based on pages fetched for this state
						const pagesProcessedForState = Math.min(
							resultsForState.length / limit,
							totalPages
						); // Approximate
						listingCounts[state] = resultsForState.length; // Update count for this state

						// Overall progress: 10 (initial) + 70 (fetching) * (current state progress + previous states progress)
						const overallStatesProgress =
							statesToFetch.indexOf(state) / statesToFetch.length;
						const currentStateProgressFraction =
							totalPages > 0 ? pagesProcessedForState / totalPages : 1;
						const progressPercentage =
							10 +
							overallStatesProgress * (70 / statesToFetch.length) +
							currentStateProgressFraction * (70 / statesToFetch.length);

						updateStatus(
							Math.round(progressPercentage),
							`Fetching ${state} listings (${resultsForState.length}/${totalStateListings})`,
							listingCounts
						);
					}
				})()
			);
		}
		await Promise.all(workerPromises);

		allListings.push(...resultsForState);
		// Final count for the state is already set inside the worker
		logger.info(`Fetched ${listingCounts[state]} listings for state: ${state}`, { syncId });
	}

	logger.info('Finished fetching all listings', {
		counts: listingCounts,
		totalFetched: allListings.length,
		syncId,
	});
	updateStatus(80, 'All listings fetched, preparing for processing', listingCounts); // Progress after all states

	const endTime = performance.now();
	logger.info(`[Perf] fetchAllListings took ${(endTime - startTime).toFixed(2)}ms`, {
		syncId,
		totalFetched: allListings.length,
	});
	return { listings: allListings, counts: listingCounts };
}

/**
 * Helper function to clean up products that don't match selected shipping profiles
 * Removes products with shipping profiles not in the configured allowlist
 * @param {string} syncId - The unique ID for this sync operation
 * @returns {Promise<Object>} Result object with count of deleted products or abort information
 */
async function removeProductsWithUnselectedShippingProfiles(syncId) {
	const overallStartTime = performance.now();
	updateSyncStatus(syncId, { currentPhase: 'Starting cleanup of products by shipping profile' });

	try {
		const selectedShippingProfiles = process.env.SYNC_SHIPPING_PROFILES
			? JSON.parse(process.env.SYNC_SHIPPING_PROFILES)
			: [];

		logger.info('Cleaning up products with non-matching shipping profiles', {
			selectedProfiles: selectedShippingProfiles,
			syncId,
		});

		if (!selectedShippingProfiles || selectedShippingProfiles.length === 0) {
			logger.info('No shipping profiles selected, skipping cleanup.', { syncId });
			completeSyncStatus(syncId, {
				removedCount: 0,
				currentPhase: 'Cleanup skipped (no profiles selected)',
			});
			return { deletedCount: 0 };
		}

		const totalEtsyProducts = await Product.countDocuments({
			'etsy_data.listing_id': { $exists: true },
		});

		const selectedProfilesAsStrings = selectedShippingProfiles.map(id => String(id));

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

		const productsToDeleteCount = await Product.countDocuments(query);
		logger.info('Products cleanup assessment', {
			totalEtsyProducts,
			productsToDeleteCount,
			percentageToDelete:
				totalEtsyProducts > 0
					? ((productsToDeleteCount / totalEtsyProducts) * 100).toFixed(2) + '%'
					: '0%',
			syncId,
		});

		updateSyncStatus(syncId, {
			currentPhase: `Assessed ${productsToDeleteCount} products for cleanup.`,
		});

		if (
			productsToDeleteCount > totalEtsyProducts * 0.5 ||
			(totalEtsyProducts > 0 && productsToDeleteCount === totalEtsyProducts)
		) {
			const abortMsg = `Safety check triggered: Would remove ${productsToDeleteCount} of ${totalEtsyProducts} products. Aborting cleanup.`;
			logger.warn(abortMsg, { syncId });
			completeSyncStatus(syncId, {
				removedCount: 0,
				error: abortMsg,
				currentPhase: 'Cleanup aborted (safety check)',
			});
			return {
				deletedCount: 0,
				aborted: true,
				reason: abortMsg,
			};
		}

		if (productsToDeleteCount === 0) {
			logger.info('No products to remove based on shipping profile filter.', { syncId });
			// completeSyncStatus(syncId, { removedCount: 0, currentPhase: 'Cleanup complete (no products to remove)' }); // Don't complete here, let syncEtsyProducts do it
			return { deletedCount: 0 };
		}

		const deleteStartTime = performance.now();
		const result = await Product.deleteMany(query);
		const deleteEndTime = performance.now();
		logger.info(
			`[Perf] removeProductsWithUnselectedShippingProfiles deleteMany took ${(deleteEndTime - deleteStartTime).toFixed(2)}ms`,
			{ deletedCount: result.deletedCount, syncId }
		);

		updateSyncStatus(syncId, {
			removedCount: result.deletedCount,
			currentPhase: `Cleaned ${result.deletedCount} products.`,
		});

		const overallEndTime = performance.now();
		logger.info(
			`[Perf] removeProductsWithUnselectedShippingProfiles total took ${(overallEndTime - overallStartTime).toFixed(2)}ms`,
			{ syncId, deletedCount: result.deletedCount }
		);
		return result;
	} catch (error) {
		logger.error('Error removing products with unselected shipping profiles:', {
			error: error.message,
			syncId,
		});
		completeSyncStatus(syncId, {
			error: `Cleanup failed: ${error.message}`,
			currentPhase: 'Cleanup failed',
		});
		throw error; // Re-throw to be handled by the caller
	}
}

/**
 * Synchronizes Etsy products with the internal database
 * Fetches product data from Etsy, processes it, and updates the database
 * @param {string} syncId - The unique ID for this sync operation used for status tracking
 * @param {Object} req - Request object for flash messages in case of errors (can be null if not from HTTP route)
 * @param {boolean} includeNonActive - Flag to include non-active listings in the sync
 * @returns {Promise<void>}
 */
async function syncEtsyProducts(syncId, req, includeNonActive = false) {
	const overallStartTime = performance.now();
	try {
		initializeSyncStatus(syncId, 'etsy', 'products', {
			currentPhase: 'Initializing Etsy product sync',
		});

		if (authService.isTokenExpired()) {
			logger.info('Auth token expired, attempting refresh for Etsy product sync', { syncId });
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
		if (!shop_id) {
			throw new Error('Etsy Shop ID not found.');
		}
		updateSyncStatus(syncId, { currentPhase: 'Fetching Etsy listings' });

		const { listings, counts: fetchedCounts } = await fetchAllListings(
			shop_id,
			syncId,
			includeNonActive
		);

		updateSyncStatus(syncId, {
			counts: fetchedCounts,
			syncCount: listings.length,
			totalCount: listings.length,
			progress: 80, // fetchAllListings now updates progress up to 80
			currentPhase: 'Processing fetched listings',
		});

		const processStartTime = performance.now();
		const bulkOps = [];
		let processedCount = 0;

		for (const listing of listings) {
			try {
				const inventory = listing.inventory;
				if (inventory?.products?.length) {
					for (const product of inventory.products) {
						const sku =
							product.sku ||
							`ETSY-${listing.listing_id}${product.property_values?.length ? '-' + product.property_values.map(pv => pv.values[0]).join('-') : ''}`;
						const op = {
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
						};
						if (product.property_values?.length) {
							const properties = new Map();
							product.property_values.forEach(prop => {
								properties.set(prop.property_name, prop.values[0]);
							});
							op.updateOne.update.$set.properties = properties;
						}
						bulkOps.push(op);
					}
				} else {
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
								$setOnInsert: { quantity_on_hand: listing.quantity },
							},
							upsert: true,
						},
					});
				}
			} catch (error) {
				logger.error(`Error processing listing ${listing.listing_id}`, {
					error: error.message,
					listing_id: listing.listing_id,
					syncId,
				});
				continue;
			}
			processedCount++;
			if (processedCount % 100 === 0 || processedCount === listings.length) {
				// Update progress every 100 items or at the end
				updateSyncStatus(syncId, {
					progress: 80 + Math.round((processedCount / listings.length) * 10), // Progress from 80 to 90
					currentPhase: `Processing listings (${processedCount}/${listings.length})`,
					processedCount: processedCount,
				});
			}
		}
		const processEndTime = performance.now();
		logger.info(
			`[Perf] Etsy product processing and DB prep took ${(processEndTime - processStartTime).toFixed(2)}ms`,
			{ syncId, operations: bulkOps.length }
		);

		updateSyncStatus(syncId, { currentPhase: 'Writing products to database', progress: 90 });

		if (bulkOps.length > 0) {
			const dbStartTime = performance.now();
			logger.info('Starting Etsy product database bulk write...', {
				syncId,
				operations: bulkOps.length,
			});
			try {
				const result = await Product.bulkWrite(bulkOps, {
					ordered: false,
					maxTimeMS: 120000,
				}); // Increased timeout
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
				updateSyncStatus(syncId, {
					currentPhase: 'Product database write complete',
					counts: {
						...fetchedCounts,
						db_inserted: result.insertedCount,
						db_updated: result.modifiedCount,
						db_upserted: result.upsertedCount,
					},
				});
			} catch (dbError) {
				logger.error('Error during Etsy product bulk write:', {
					syncId,
					error: dbError.message,
					stack: dbError.stack,
				});
				// Don't throw, allow cleanup to run, but mark error in status
				completeSyncStatus(
					syncId,
					{ error: `DB Write Failed: ${dbError.message}` },
					dbError
				);
				// If req is available, set flash message
				if (req && req.flash) {
					req.flash('error', `Error writing Etsy products to DB: ${dbError.message}`);
				}
				// Potentially re-throw or handle more gracefully depending on desired behavior
				// For now, we let it proceed to cleanup but the error is logged and status updated.
			}
		} else {
			logger.info('No Etsy product changes to write to database', { syncId });
			updateSyncStatus(syncId, { currentPhase: 'No product changes for DB' });
		}

		updateSyncStatus(syncId, {
			progress: 95,
			currentPhase: 'Cleaning up products by shipping profile',
		});
		const cleanupResult = await removeProductsWithUnselectedShippingProfiles(syncId); // Pass syncId

		const finalStatusUpdate = {
			removedCount: cleanupResult.deletedCount || 0,
			// Counts should already include fetchedCounts and DB counts from previous updates
		};
		if (cleanupResult.aborted) {
			finalStatusUpdate.error = cleanupResult.reason;
			finalStatusUpdate.currentPhase = `Sync complete with cleanup aborted: ${cleanupResult.reason}`;
		} else {
			finalStatusUpdate.currentPhase = 'Etsy product sync complete';
		}

		completeSyncStatus(
			syncId,
			finalStatusUpdate,
			cleanupResult.aborted ? new Error(cleanupResult.reason) : null
		);
		logger.info(
			`Etsy product sync finished. ${cleanupResult.aborted ? 'Cleanup aborted.' : `Removed ${cleanupResult.deletedCount || 0} products.`}`,
			{ syncId }
		);

		await Settings.setSetting('lastEtsyProductSync', new Date().toISOString());
	} catch (error) {
		logger.error('Error syncing Etsy products', {
			syncId,
			error: error.message,
			stack: error.stack,
		});
		completeSyncStatus(syncId, {}, error);
		if (req && req.flash) {
			req.flash('error', `Error syncing Etsy products: ${error.message}`);
		}
		// Do not re-throw here if called from a route, as the route handler might try to send a response after this.
		// The error is already logged and status updated.
	} finally {
		const overallEndTime = performance.now();
		logger.info(
			`[Perf] Overall syncEtsyProducts took ${(overallEndTime - overallStartTime).toFixed(2)}ms`,
			{ syncId }
		);
	}
}

/**
 * Synchronizes Etsy orders with the internal database
 * Fetches order data from Etsy API, processes it, and updates the database
 *
 * @param {string} syncId - The unique ID for this sync operation.
 * @param {Object} req - Express request object (optional, for flash messages).
 * @returns {Promise<void>} - Resolves when sync is complete.
 * @throws {Error} - If there's a critical error during the synchronization process.
 */
async function syncEtsyOrders(syncId, req) {
	// req is optional
	const overallStartTime = performance.now();
	// const syncId = validateSyncId(req?.query?.syncId || req, 'etsy', 'orders'); // syncId is now passed directly
	const ORDER_SYNC_CONCURRENCY = parseInt(process.env.ORDER_SYNC_CONCURRENCY, 10) || 5;
	let newOrderCount = 0;
	let updatedOrderCount = 0;

	try {
		initializeSyncStatus(syncId, 'etsy', 'orders', {
			currentPhase: 'Initializing Etsy order sync',
		});

		if (authService.isTokenExpired()) {
			logger.info('Auth token expired, attempting refresh for Etsy order sync', { syncId });
			await authService.refreshToken();
			logger.info('Auth token refreshed successfully for Etsy order sync', { syncId });
		}

		const shopId = await getShopId();
		if (!shopId) {
			throw new Error('Etsy shop ID not configured.');
		}

		const limit = 100; // Max receipts per page for Etsy
		let totalFetchedReceipts = 0;
		const allReceipts = [];
		const requestTimings = []; // For performance monitoring

		let minCreatedTimestamp = null;
		const lastSync = await Settings.getSetting('lastEtsyOrderSync');
		if (lastSync) {
			minCreatedTimestamp =
				Math.floor(new Date(lastSync).getTime() / 1000) - 60 * 60 * 24 * 2; // 2-day overlap to be safe
			logger.info(
				`Syncing Etsy orders created since: ${new Date(minCreatedTimestamp * 1000).toISOString()}`,
				{ syncId }
			);
		} else {
			logger.info(
				'No previous Etsy order sync found, fetching recent orders (Etsy API default is 90 days for min_created=0).',
				{ syncId }
			);
		}
		const minCreated = minCreatedTimestamp || 0; // Use 0 if no last sync (Etsy defaults to 90 days back)

		updateSyncStatus(syncId, { currentPhase: 'Fetching Etsy order count', progress: 5 });

		// Get auth headers (access token)
		const accessToken = authService.getAccessToken();
		if (!accessToken) {
			throw new Error('Etsy access token not available for order sync.');
		}
		const headers = {
			'x-api-key': process.env.ETSY_API_KEY,
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json',
		};

		// Initial request to get total count
		const firstUrl = `${API_BASE_URL}/application/shops/${shopId}/receipts?limit=1&offset=0&min_created=${minCreated}`;
		let response = await etsyRequest(() => etsyFetch(firstUrl, { headers }), {
			method: 'GET',
			endpoint: '/receipts',
			offset: 0,
			syncId,
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Failed to fetch initial Etsy order count: ${response.status} ${errorText}`
			);
		}

		const firstData = await response.json();
		const totalReceiptsToFetch = firstData.count || 0;

		if (totalReceiptsToFetch === 0) {
			logger.info('No new Etsy orders found to sync.', { syncId });
			completeSyncStatus(syncId, {
				counts: { added: 0, updated: 0 },
				currentPhase: 'No new orders',
			});
			await Settings.setSetting('lastEtsyOrderSync', new Date().toISOString());
			return;
		}

		updateSyncStatus(syncId, {
			totalCount: totalReceiptsToFetch,
			currentPhase: `Fetching ${totalReceiptsToFetch} Etsy orders`,
			progress: 10,
		});

		const totalPages = Math.ceil(totalReceiptsToFetch / limit);
		const pageOffsets = Array.from({ length: totalPages }, (_, i) => i * limit);

		let fetchedForDbProcessing = 0;

		if (pageOffsets.length > 0) {
			const results = [];
			let currentOffsetIndex = 0; // Shared index for workers to pull from

			const worker = async workerId => {
				while (true) {
					const myOffsetIndex = currentOffsetIndex++;
					if (myOffsetIndex >= pageOffsets.length) {
						break; // All pages assigned
					}
					const currentOffset = pageOffsets[myOffsetIndex];

					let retries = 0;
					const MAX_RETRIES_PAGE = 3;
					while (retries < MAX_RETRIES_PAGE) {
						try {
							const url = `${API_BASE_URL}/application/shops/${shopId}/receipts?limit=${limit}&offset=${currentOffset}&min_created=${minCreated}&includes=Transactions,Listings,User`;
							const reqStart = Date.now();
							let resp = await etsyRequest(() => etsyFetch(url, { headers }), {
								method: 'GET',
								endpoint: '/receipts',
								offset: currentOffset,
								syncId,
							});
							let reqDuration = Date.now() - reqStart;
							requestTimings.push(reqDuration);
							// logger.debug(`Worker ${workerId}: Fetched batch in ${reqDuration}ms (offset=${currentOffset})`, {syncId});

							if (!resp.ok) {
								const errorText = await resp.text();
								logger.warn(
									`Worker ${workerId}: Failed to fetch Etsy orders page (offset ${currentOffset}), status ${resp.status}. Retrying...`,
									{
										syncId,
										error: errorText.substring(0, 100),
										attempt: retries + 1,
									}
								);
								if (resp.status === 429 || resp.status >= 500) {
									// Retry on rate limit or server error
									await new Promise(r =>
										setTimeout(r, RETRY_DELAY * Math.pow(2, retries))
									); // RETRY_DELAY needs to be defined
									retries++;
									continue;
								}
								throw new Error(`Failed to fetch Etsy orders page: ${resp.status}`);
							}
							const data = await resp.json();
							results.push(...(data.results || []));
							totalFetchedReceipts += (data.results || []).length;
							break; // Success for this page
						} catch (err) {
							logger.error(
								`Worker ${workerId}: Error fetching Etsy orders page (offset ${currentOffset})`,
								{ syncId, error: err.message, attempt: retries + 1 }
							);
							retries++;
							if (retries < MAX_RETRIES_PAGE) {
								await new Promise(r =>
									setTimeout(r, RETRY_DELAY * Math.pow(2, retries))
								); // RETRY_DELAY needs to be defined
							} else {
								logger.error(
									`Worker ${workerId}: Max retries reached for page fetch (offset ${currentOffset})`,
									{ syncId }
								);
								// Potentially mark this page as failed and continue? For now, it just means fewer results.
							}
						}
					}

					// Update progress based on total fetched receipts across all workers
					const currentProgress =
						10 + Math.round((totalFetchedReceipts / totalReceiptsToFetch) * 70); // Fetching phase up to 80%
					updateSyncStatus(syncId, {
						syncCount: totalFetchedReceipts,
						progress: currentProgress,
						currentPhase: `Fetching orders (${totalFetchedReceipts}/${totalReceiptsToFetch})`,
					});
				}
			};

			const workerPromises = [];
			for (let i = 0; i < ORDER_SYNC_CONCURRENCY; i++) {
				workerPromises.push(worker(i + 1));
			}
			await Promise.all(workerPromises);
			allReceipts.push(...results); // Add all fetched results
		}

		logger.info(
			`Finished fetching ${allReceipts.length} Etsy receipts. Expected ${totalReceiptsToFetch}.`,
			{ syncId }
		);
		updateSyncStatus(syncId, {
			currentPhase: 'Processing fetched Etsy orders',
			progress: 80,
			syncCount: allReceipts.length, // Actual number fetched
			processedCount: 0, // Reset for processing phase
			totalCount: allReceipts.length, // Process all fetched
		});

		if (allReceipts.length > 0) {
			const bulkOps = [];
			const existingOrderIds = new Set(
				(
					await Order.find({
						order_id: { $in: allReceipts.map(r => r.receipt_id.toString()) },
						marketplace: 'etsy',
					})
						.select('order_id')
						.lean()
				).map(o => o.order_id)
			);

			for (let i = 0; i < allReceipts.length; i++) {
				const receipt = allReceipts[i];
				const receiptIdStr = receipt.receipt_id.toString();
				try {
					const isExistingOrder = existingOrderIds.has(receiptIdStr);

					const items = (receipt.transactions || []).map(tx => ({
						transaction_id: tx.transaction_id.toString(),
						listing_id: tx.listing_id?.toString(), // Ensure listing_id is string
						title: tx.title,
						sku: tx.product_data?.sku || tx.sku,
						quantity: tx.quantity,
						price: parseFloat(tx.price.amount) / tx.price.divisor,
						variations:
							tx.variations?.map(v => ({
								property_id: v.property_id,
								value_id: v.value_id,
								formatted_name: v.formatted_name,
								formatted_value: v.formatted_value,
							})) || [],
					}));

					const shippedDate = receipt.shipments?.[0]?.receipt_shipping_id
						? new Date(receipt.shipments[0].mail_date * 1000)
						: null;

					const update = {
						$set: {
							etsy_order_data: receipt, // Store the raw receipt
							marketplace: 'etsy',
							status:
								receipt.status !== 'Canceled'
									? receipt.is_shipped
										? 'shipped'
										: 'unshipped'
									: 'canceled',
							buyer_name: receipt.name || 'N/A', // Etsy API provides 'name' on receipt for buyer
							order_date: new Date(receipt.created_timestamp * 1000),
							shipped_date: shippedDate,
							receipt_id: receiptIdStr, // This is the Etsy order ID
							items,
							// Add other relevant transformed fields as needed
							grandtotal:
								parseFloat(receipt.grandtotal.amount) / receipt.grandtotal.divisor,
							currency_code: receipt.grandtotal.currency_code,
							last_updated: new Date(), // Timestamp of this sync update
						},
						$setOnInsert: {
							order_id: receiptIdStr, // Set on insert only
						},
					};
					bulkOps.push({
						updateOne: {
							filter: { order_id: receiptIdStr, marketplace: 'etsy' },
							update: update,
							upsert: true,
						},
					});

					if (isExistingOrder) {
						updatedOrderCount++;
					} else {
						newOrderCount++;
					}

					fetchedForDbProcessing++;
					if (
						fetchedForDbProcessing % 50 === 0 ||
						fetchedForDbProcessing === allReceipts.length
					) {
						updateSyncStatus(syncId, {
							currentPhase: `Processing orders (${fetchedForDbProcessing}/${allReceipts.length})`,
							progress:
								80 + Math.round((fetchedForDbProcessing / allReceipts.length) * 15), // 80-95%
							processedCount: fetchedForDbProcessing,
						});
					}
				} catch (error) {
					logger.error(`Error processing Etsy receipt ${receiptIdStr}`, {
						syncId,
						error: error.message,
						receiptId: receiptIdStr,
					});
				}
			}

			if (bulkOps.length > 0) {
				updateSyncStatus(syncId, {
					currentPhase: 'Writing Etsy orders to database',
					progress: 95,
				});
				logger.info(`Writing ${bulkOps.length} Etsy order operations to database`, {
					syncId,
				});
				const dbWriteStartTime = Date.now();
				const result = await Order.bulkWrite(bulkOps, {
					ordered: false,
					maxTimeMS: 120000,
				});
				logger.info(`[Perf] Etsy Order.bulkWrite took ${Date.now() - dbWriteStartTime}ms`, {
					syncId,
					upserted: result.upsertedCount,
					modified: result.modifiedCount,
					matched: result.matchedCount,
					newOrders: newOrderCount,
					updatedOrders: updatedOrderCount,
				});

				completeSyncStatus(syncId, {
					counts: {
						added: newOrderCount,
						updated: updatedOrderCount,
						fetched: allReceipts.length,
					},
					currentPhase: 'Etsy order sync complete',
				});
			} else {
				logger.info('No Etsy orders to write to database after processing.', { syncId });
				completeSyncStatus(syncId, {
					counts: { added: 0, updated: 0, fetched: allReceipts.length },
					currentPhase: 'No orders to write',
				});
			}
		} else {
			logger.info('No Etsy orders found to process after fetching.', { syncId });
			completeSyncStatus(syncId, {
				counts: { added: 0, updated: 0, fetched: 0 },
				currentPhase: 'No orders fetched',
			});
		}

		await Settings.setSetting('lastEtsyOrderSync', new Date().toISOString());
		logger.info(
			`Etsy order sync completed. Synced ${newOrderCount} new and ${updatedOrderCount} existing orders. Fetched ${allReceipts.length} total.`,
			{ syncId }
		);
	} catch (error) {
		logger.error('Critical error during Etsy order sync:', {
			syncId,
			error: error.message,
			stack: error.stack,
		});
		completeSyncStatus(syncId, { currentPhase: 'Failed' }, error);
		if (req && req.flash) {
			// Check if req and req.flash exist
			req.flash('error', `Error syncing Etsy orders: ${error.message}`);
		}
		// Do not re-throw if called from a route context, error is handled.
	} finally {
		const overallEndTime = performance.now();
		logger.info(
			`[Perf] Overall syncEtsyOrders took ${(overallEndTime - overallStartTime).toFixed(2)}ms`,
			{ syncId }
		);
		// Ensure status is marked complete even if an intermediate step failed to call it
		const currentStatus = getSyncStatus(syncId);
		if (currentStatus && !currentStatus.complete) {
			completeSyncStatus(
				syncId,
				{ currentPhase: 'Sync ended (final check)' },
				currentStatus.error ? new Error(currentStatus.error) : null
			);
		}
	}
}

module.exports = {
	fetchAllListings,
	syncEtsyProducts, // Added
	syncEtsyOrders, // Added
	removeProductsWithUnselectedShippingProfiles, // Added
};
