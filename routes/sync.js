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

// In-memory store for sync status
const syncStatus = new Map();

// --- Helper Function to Parse JSON with Logging ---
// async function parseJsonResponse(response, url) {
//     let responseText = ''; // Store raw text
//     try {
//         // Clone response to allow reading text even if json parsing fails
//         const clonedResponse = response.clone();
//         responseText = await clonedResponse.text();
//         // Attempt to parse original response
//         const jsonData = await response.json();
//         return jsonData;
//     } catch (error) {
//         logger.error(`Failed to parse JSON response from ${url}`, {
//             status: response.status,
//             statusText: response.statusText,
//             responseText: responseText.substring(0, 500), // Log first 500 chars
//             parseErrorMessage: error.message,
//         });
//         // Re-throw a more informative error
//         throw new Error(`Failed to parse JSON response from ${url}. Status: ${response.status}. Response snippet: ${responseText.substring(0, 100)}`);
//     }
// }

// Sync dashboard
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
            lastShopifyOrderSyncDoc // Added for Shopify order sync time
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
                .lean()
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
                lastInventorySync: null // Placeholder - still needs data source
            },
            activePage: 'sync', // Add activePage here
            // Pass sync times to the template, formatting them
            lastEtsyOrderSync: etsySyncTime ? new Date(etsySyncTime).toLocaleString() : 'N/A',
            lastShopifyOrderSync: shopifySyncTime ? new Date(shopifySyncTime).toLocaleString() : 'N/A',
            lastEtsyProductSync: etsyProductSyncTime ? new Date(etsyProductSyncTime).toLocaleString() : 'N/A',
            lastShopifyProductSync: shopifyProductSyncTime ? new Date(shopifyProductSyncTime).toLocaleString() : 'N/A'
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
                lastInventorySync: null 
            }, 
            activePage: 'sync' 
        }); 
    }
});

// Helper function to fetch all listings in bulk
async function fetchAllListings(shop_id, syncId) {
    const startTime = performance.now();
    const listingCounts = {
        active: 0,
        draft: 0,
        expired: 0,
        inactive: 0,
        sold_out: 0
    };
    const allListings = [];

    // Update status if syncId is provided
    const updateStatus = (progress, currentPhase = '') => {
        if (syncId) {
            const status = syncStatus.get(syncId);
            if (status) {
                status.counts = {...listingCounts};
                status.progress = progress;
                // Calculate total items processed so far
                status.syncCount = Object.values(listingCounts).reduce((sum, count) => sum + count, 0);
                if (currentPhase) {
                    status.currentPhase = currentPhase;
                }
                syncStatus.set(syncId, status);
                console.log(`Updated status for ${syncId}:`, status);
            }
        }
    };

    // Fetch active listings (includes draft and sold out)
    let offset = 0;
    const limit = 100;
    const tokenData = JSON.parse(process.env.TOKEN_DATA);
    
    // Get selected shipping profiles to filter by
    const selectedShippingProfiles = process.env.SYNC_SHIPPING_PROFILES ? 
        JSON.parse(process.env.SYNC_SHIPPING_PROFILES) : [];
    
    const hasShippingProfileFilter = selectedShippingProfiles.length > 0;
    logger.info('Fetching listings with shipping profile filter', { 
        filterEnabled: hasShippingProfileFilter,
        selectedProfiles: selectedShippingProfiles
    });
    
    var headers = new Headers();
    
    const states = ['active', 'draft', 'expired', 'inactive', 'sold_out'];

    headers.append("x-api-key", process.env.ETSY_API_KEY);
    headers.append("Authorization", `Bearer ${tokenData.access_token}`);

    let urlencoded = new URLSearchParams();
    urlencoded.append("state", "active");
    urlencoded.append("limit", limit);
    urlencoded.append("offset", offset);
    // Request ALL available data by including all available fields
    urlencoded.append("includes", "Shipping,Images,Shop,User,Translations,Inventory,Videos");

    let i = 0;
    logger.info('Fetching all listings with complete data...');
    updateStatus(10); // Initial status update
    
    // Define fetchLoopStartTime before the loop
    const fetchLoopStartTime = performance.now();
    while (true) {
        const loopIterationStartTime = performance.now();
        try {
            logger.debug(`Fetching ${states[i]} listings, offset ${offset}...`);
            
            const state = states[i];
            urlencoded.set('offset', offset);
            urlencoded.set('state', state);
            
            let requestOptions = {
                method: 'GET',
                headers: headers,
                redirect: 'follow'
            };

            // Define the URL string before using it
            const fetchUrl = `https://openapi.etsy.com/v3/application/shops/${shop_id}/listings?${urlencoded.toString()}`;

            // Use etsyFetch instead of the undefined rateLimitedFetch
            const response = await etsyFetch(
                fetchUrl, // Use the defined URL string
                requestOptions
            );

            if (!response.ok) {
                const errorText = await response.text();
                logger.error('Error fetching listings:', {
                    status: response.status,
                    statusText: response.statusText,
                    details: errorText
                });
                throw new Error(`Failed to fetch listings: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            const listings = data.results || [];
            
            // Filter listings by shipping profile if filter is enabled
            const filteredListings = hasShippingProfileFilter ? 
                listings.filter(listing => 
                    selectedShippingProfiles.includes(listing.shipping_profile_id?.toString())
                ) : 
                listings;
            
            if (hasShippingProfileFilter) {
                logger.debug(`Filtered ${listings.length - filteredListings.length} listings by shipping profile`);
            }
            
            listingCounts[state] = listingCounts[state] + filteredListings.length; 
            allListings.push(...filteredListings);

            offset = offset + limit;

            // Update progress based on how many listing states we've completed
            const progressValue = 10 + Math.round((i / states.length) * 70) + 
                (listings.length < limit ? 3 : 0); // Extra progress when completing a state
            updateStatus(progressValue);

            // Once we get an empty response, we can stop fetching
            if (listings.length < limit) {
                logger.debug(`No more listings for state: ${states[i]}`);
                i++;
                if (i >= states.length) {
                    break; // All states have been processed
                }
                
                // Then change to the next state
                offset = 0; // Reset offset for the next state
            }
        } catch (error) {
            logger.error(`Error fetching ${states[i]} listings at offset ${offset}:`, {
                error: error.message,
                state: states[i],
                offset
            });
            throw error; // Re-throw to handle in the calling function
        }
        const loopIterationEndTime = performance.now();
        logger.debug(`[Perf] Etsy fetchAllListings iteration took ${(loopIterationEndTime - loopIterationStartTime).toFixed(2)}ms`, { syncId, state: states[i], offset });
    }
    const fetchLoopEndTime = performance.now();
    logger.info(`[Perf] Etsy fetchAllListings loop took ${(fetchLoopEndTime - fetchLoopStartTime).toFixed(2)}ms`, { syncId });

    logger.info('Finished fetching all listings', { counts: listingCounts });
    updateStatus(30); // Final update after all listings are fetched
    const endTime = performance.now();
    logger.info(`[Perf] fetchAllListings took ${(endTime - startTime).toFixed(2)}ms`, { syncId });
    return { listings: allListings, counts: listingCounts };
}

// Helper function to clean up products that don't match selected shipping profiles
async function removeProductsWithUnselectedShippingProfiles() {
    const startTime = performance.now();
    try {
        // Get selected shipping profiles from environment variables
        const selectedShippingProfiles = process.env.SYNC_SHIPPING_PROFILES ? 
            JSON.parse(process.env.SYNC_SHIPPING_PROFILES) : [];
        
        logger.info('Cleaning up products with non-matching shipping profiles', {
            selectedProfiles: selectedShippingProfiles
        });
        
        // If no shipping profiles are selected, don't delete anything
        if (!selectedShippingProfiles || selectedShippingProfiles.length === 0) {
            logger.info('No shipping profiles selected, skipping cleanup');
            return { deletedCount: 0 };
        }
        
        // Safety check: If we're about to delete more than 50% of products, abort
        const totalEtsyProducts = await Product.countDocuments({
            'etsy_data.listing_id': { $exists: true }
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
                { 'etsy_data.shipping_profile_id': { $exists: true, $nin: selectedProfilesAsStrings } }
            ]
        };

        const queryStartTime = performance.now();
        const productsToDelete = await Product.countDocuments(query);
        const queryEndTime = performance.now();
        logger.info(`[Perf] removeProductsWithUnselectedShippingProfiles count query took ${(queryEndTime - queryStartTime).toFixed(2)}ms`);

        logger.info('Products cleanup assessment', {
            totalEtsyProducts,
            productsToDelete,
            percentageToDelete: totalEtsyProducts > 0 ? (productsToDelete / totalEtsyProducts * 100).toFixed(2) + '%' : '0%'
        });
        
        // Safety check
        if (productsToDelete > totalEtsyProducts * 0.5 || 
            (totalEtsyProducts > 0 && productsToDelete === totalEtsyProducts)) {
            logger.warn(`Safety check triggered: Would remove ${productsToDelete} out of ${totalEtsyProducts} products. Skipping automated cleanup.`);
            return { 
                deletedCount: 0, 
                aborted: true, 
                reason: 'Safety check triggered - too many products would be deleted' 
            };
        }
        
        const deleteStartTime = performance.now();
        // Direct approach: execute the delete operation with the same query
        const result = await Product.deleteMany(query);
        const deleteEndTime = performance.now();
        logger.info(`[Perf] removeProductsWithUnselectedShippingProfiles deleteMany took ${(deleteEndTime - deleteStartTime).toFixed(2)}ms`, { deletedCount: result.deletedCount });

        const endTime = performance.now();
        logger.info(`[Perf] removeProductsWithUnselectedShippingProfiles total took ${(endTime - startTime).toFixed(2)}ms`, { deletedCount: result.deletedCount });
        return result;
    } catch (error) {
        logger.error('Error removing products with unselected shipping profiles:', { 
            error: error.message
        });
        throw error;
    }
}

// Sync Etsy products
router.get('/sync-etsy', async (req, res) => {
    try {
        // Get the sync ID from the query parameter
        const syncId = req.query.syncId || Date.now().toString();
        console.log(`Starting Etsy sync with syncId: ${syncId}`);
        
        // Initialize sync status
        syncStatus.set(syncId, {
            syncCount: 0,
            counts: {
                active: 0,
                draft: 0,
                expired: 0,
                inactive: 0,
                sold_out: 0
            },
            removedCount: 0,
            progress: 5, // Start with 5% to show something is happening
            complete: false,
            error: null
        });
        
        // Start the sync process without waiting for it to complete
        syncEtsyProducts(syncId, req)
            .catch(error => {
                logger.error('Error in background Etsy sync:', { error: error.message });
                
                // Update sync status with error
                const status = syncStatus.get(syncId);
                if (status) {
                    status.complete = true;
                    status.error = error.message;
                    syncStatus.set(syncId, status);
                }
            });
        
        // If the request is from fetch (Ajax), send a JSON response
        // Otherwise redirect to the sync page
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            res.json({ 
                success: true, 
                message: 'Sync started successfully', 
                syncId 
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
                error: error.message 
            });
        } else {
            req.flash('error', `Error starting Etsy sync: ${error.message}`);
            res.redirect('/sync');
        }
    }
});

router.get('/sync-shopify', async (req, res) => {
    const syncId = req.query.syncId || Date.now().toString();
    console.log(`Starting Shopify sync with syncId: ${syncId}`);

    // Initialize sync status
    syncStatus.set(syncId, {
        syncCount: 0, // Placeholder, will be updated
        counts: {}, // Placeholder
        removedCount: 0, // Placeholder
        progress: 5, // Start with 5%
        complete: false,
        error: null,
        currentPhase: 'Initializing'
    });

    // Start the sync process in the background, passing the syncId
    syncShopifyProducts(syncId, req) // Pass syncId here
        .catch(error => {
            // This catch is for errors thrown *synchronously* before the async function really gets going
            // or if the async function itself isn't caught internally properly (should be avoided).
            logger.error('Error directly from syncShopifyProducts invocation:', { syncId, error: error.message });
            const status = syncStatus.get(syncId);
            if (status) {
                status.complete = true;
                status.error = `Failed to start Shopify sync: ${error.message}`;
                status.progress = 100; // Mark as complete even on error start
                syncStatus.set(syncId, status);
            }
        });

    // Respond immediately to the client with the syncId
    res.json({
        success: true,
        message: 'Shopify sync started successfully',
        syncId // Return the syncId
    });
});

// Background Etsy product sync function
async function syncEtsyProducts(syncId, req) {
    const overallStartTime = performance.now();
    const status = syncStatus.get(syncId);
    try {
        logger.info('Starting Etsy product sync', { syncId });
        const shop_id = await getShopId();
        status.currentPhase = 'Fetching listings';
        syncStatus.set(syncId, status);

        // Fetch all listings
        const { listings, counts } = await fetchAllListings(shop_id, syncId);
        status.counts = counts;
        status.syncCount = listings.length;
        status.progress = 30;
        status.currentPhase = 'Processing listings';
        syncStatus.set(syncId, status);

        // Process listings
        const processStartTime = performance.now();
        const bulkOps = [];
        for (const listing of listings) {
            try {
                const inventory = listing.inventory;
                
                if (inventory?.products?.length) {
                    // Handle listings with variations
                    for (const product of inventory.products) {
                        const sku = product.sku || `ETSY-${listing.listing_id}${product.property_values?.length ? '-' + product.property_values.map(pv => pv.values[0]).join('-') : ''}`;
                        
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
                                            last_raw_sync: new Date()
                                        },
                                        etsy_data: {
                                            listing_id: listing.listing_id.toString(),
                                            title: listing.title,
                                            description: listing.description,
                                            price: listing.price.amount / listing.price.divisor,
                                            quantity: product.offerings?.[0]?.quantity || 0,
                                            status: listing.state,
                                            tags: listing.tags || [],
                                            shipping_profile_id: listing.shipping_profile_id?.toString(),
                                            images: listing.images?.map(img => ({
                                                url: img.url_fullxfull,
                                                alt: img.alt_text || ''
                                            })) || [],
                                            last_synced: new Date()
                                        }
                                    },
                                    $setOnInsert: {
                                        quantity_on_hand: product.offerings?.[0]?.quantity || 0
                                    }
                                },
                                upsert: true
                            }
                        });

                        // Add variation details if they exist
                        if (product.property_values?.length) {
                            const properties = new Map();
                            product.property_values.forEach(prop => {
                                properties.set(prop.property_name, prop.values[0]);
                            });
                            bulkOps[bulkOps.length - 1].updateOne.update.$set.properties = properties;
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
                                        last_raw_sync: new Date()
                                    },
                                    etsy_data: {
                                        listing_id: listing.listing_id.toString(),
                                        title: listing.title,
                                        description: listing.description,
                                        price: listing.price.amount / listing.price.divisor,
                                        quantity: listing.quantity,
                                        status: listing.state,
                                        tags: listing.tags || [],
                                        shipping_profile_id: listing.shipping_profile_id?.toString(),
                                        images: listing.images?.map(img => ({
                                            url: img.url_fullxfull,
                                            alt: img.alt_text || ''
                                        })) || [],
                                        last_synced: new Date()
                                    }
                                },
                                $setOnInsert: {
                                    quantity_on_hand: listing.quantity
                                }
                            },
                            upsert: true
                        }
                    });
                }
            } catch (error) {
                logger.error(`Error processing listing ${listing.listing_id}`, { 
                    error: error.message,
                    listing_id: listing.listing_id
                });
                continue;
            }
        }
        const processEndTime = performance.now();
        logger.info(`[Perf] Etsy listing processing loop took ${(processEndTime - processStartTime).toFixed(2)}ms`, { syncId, count: listings.length });

        status.progress = 70;
        status.currentPhase = 'Updating database';
        syncStatus.set(syncId, status);

        // Perform bulk write
        if (bulkOps.length > 0) {
            const dbStartTime = performance.now();
            const result = await Product.bulkWrite(bulkOps, { ordered: false });
            const dbEndTime = performance.now();
            logger.info(`[Perf] Etsy Product.bulkWrite took ${(dbEndTime - dbStartTime).toFixed(2)}ms`, { 
                syncId,
                inserted: result.insertedCount,
                updated: result.modifiedCount,
                upserted: result.upsertedCount
            });
        } else {
            logger.info('No Etsy product changes to write to database', { syncId });
        }

        // Clean up products based on shipping profiles
        status.progress = 90;
        status.currentPhase = 'Cleaning up';
        syncStatus.set(syncId, status);
        const cleanupResult = await removeProductsWithUnselectedShippingProfiles();
        status.removedCount = cleanupResult.deletedCount || 0;

        // Mark sync as complete
        status.progress = 100;
        status.complete = true;
        status.currentPhase = 'Complete';
        syncStatus.set(syncId, status);
        logger.info('Etsy product sync completed successfully', { syncId });

        // Record successful sync time in Settings
        await Settings.setSetting('lastEtsyProductSync', new Date().toISOString());

    } catch (error) {
        logger.error('Error syncing Etsy products in background', { error: error.message });
        
        // Update status with error
        const status = syncStatus.get(syncId);
        if (status) {
            status.complete = true;
            status.error = error.message;
            syncStatus.set(syncId, status);
        }
        
        // Set flash error to be shown on next page load
        if (req.session) {
            req.session.flash = {
                error: `Error syncing products from Etsy: ${error.message}`
            };
        }
        
        throw error; // Re-throw to be caught by the caller
    } finally {
        const overallEndTime = performance.now();
        logger.info(`[Perf] Overall syncEtsyProducts took ${(overallEndTime - overallStartTime).toFixed(2)}ms`, { syncId });
    }
}

async function getNewestFile(dirPath) {
    try {
      // Corrected: Call readdir directly on fs (which is fs.promises)
      const files = await fs.readdir(dirPath); 
  
      if (files.length === 0) {
        return null; // Return null if the directory is empty
      }
  
      const filesWithStats = await Promise.all(
        files.map(async (file) => {
          const filePath = path.join(dirPath, file);
          // Corrected: Call stat directly on fs
          const stats = await fs.stat(filePath); 
          return { file, stats };
        })
      );
  
      const newestFile = filesWithStats.reduce((prev, curr) => {
        return (prev.stats.mtimeMs > curr.stats.mtimeMs) ? prev : curr;
      });
      return newestFile.file;
    } catch (err) {
      console.error("Error reading directory:", err);
      throw err;
    }
}

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
            logger.info(`Cleaning up ${filesToDelete.length} old data files with prefix "${prefix}"...`);
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
        status.currentPhase = 'Checking existing data';
        status.progress = 10;
        syncStatus.set(syncId, status);

        const existingData = await getNewestFile(directoryPath);

        if (existingData && existingData.startsWith(filePrefix) && path.parse(existingData).name.split('_').pop() > Date.now() - 1000 * 60 * 60 * 2) {
            logger.info(`Using existing data file: ${existingData}`, { syncId });
            fileName = path.resolve(directoryPath, existingData);
            status.currentPhase = 'Using cached data';
            status.progress = 20; // Jump ahead if using cache
            syncStatus.set(syncId, status);
            url = 'local'; // Indicate local file usage
        } else {
            logger.info('Existing data file is old or missing, fetching new data from Shopify...', { syncId });
            status.currentPhase = 'Requesting bulk export';
            status.progress = 15;
            syncStatus.set(syncId, status);

            // Use direct Shopify client as in sync_old.js
            const shopify = new Shopify({
                shopName: process.env.SHOPIFY_SHOP_NAME,
                accessToken: process.env.SHOPIFY_ACCESS_TOKEN
            });

            const query = `mutation { bulkOperationRunQuery( query: """ { products { edges { node { id handle title descriptionHtml vendor status productType tags onlineStoreUrl media(first: 10) { edges { node { preview { image { url altText } } ... on MediaImage { image { id url altText } } } } } variants(first: 50) { edges { node { id sku price inventoryQuantity inventoryItem { id inventoryLevels(first: 10) { edges { node { location { id name } } } } } } } } } } } } } """ ) { bulkOperation { id status } userErrors { field message } } }`;

            try {
                logger.info('Requesting Shopify bulk product export...', { syncId });
                const initialResult = await shopify.graphql(query);
                logger.debug('Received initial result from Shopify GraphQL:', { syncId, initialResult });

                if (initialResult.bulkOperationRunQuery?.userErrors?.length > 0) {
                    logger.error('Shopify bulk operation user errors:', { syncId, errors: initialResult.bulkOperationRunQuery.userErrors });
                    // Throw error to be caught by the outer catch block which updates status
                    throw new Error(`Shopify user errors: ${initialResult.bulkOperationRunQuery.userErrors.map(e => e.message).join(', ')}`);
                }

                if (!initialResult.bulkOperationRunQuery?.bulkOperation?.id) {
                    logger.error('Unexpected response structure from Shopify bulk operation initiation:', { syncId, initialResult });
                    // Throw error to be caught by the outer catch block
                    throw new Error('Failed to initiate Shopify bulk operation or retrieve ID.');
                }

                bulkOperationId = initialResult.bulkOperationRunQuery.bulkOperation.id;
                let operationStatus = initialResult.bulkOperationRunQuery.bulkOperation.status;
                logger.info(`Shopify bulk operation started. ID: ${bulkOperationId}, Status: ${operationStatus}`, { syncId });

                status.currentPhase = 'Polling bulk export status';
                status.progress = 20;
                syncStatus.set(syncId, status);

                const queryJob = `query { node(id: "${bulkOperationId}") { ... on BulkOperation { id status errorCode createdAt completedAt objectCount fileSize url partialDataUrl } } }`;
                const MAX_POLL_ATTEMPTS = 60;
                const POLL_INTERVAL_MS = 5000;
                let pollAttempts = 0;

                while (pollAttempts < MAX_POLL_ATTEMPTS) {
                    pollAttempts++;
                    await shopifyHelpers.sleep(POLL_INTERVAL_MS);
                    logger.debug(`Polling Shopify bulk operation status (Attempt ${pollAttempts})...`, { syncId });
                    const pollResult = await shopify.graphql(queryJob);

                    if (!pollResult.node) {
                        logger.warn(`Bulk operation ${bulkOperationId} not found during polling.`, { syncId });
                        continue;
                    }

                    operationStatus = pollResult.node.status;
                    logger.debug(`Bulk operation status: ${operationStatus}`, { syncId });

                    // Update progress slightly during polling
                    status.progress = 20 + Math.min(60, Math.round((pollAttempts / MAX_POLL_ATTEMPTS) * 20)); // Progress from 20% to 40% during polling
                    syncStatus.set(syncId, status);


                    if (operationStatus === 'COMPLETED') {
                        url = pollResult.node.url;
                        logger.info(`Shopify bulk operation ${bulkOperationId} completed successfully. URL: ${url}`, { syncId });
                        status.currentPhase = 'Downloading data';
                        status.progress = 40;
                        syncStatus.set(syncId, status);
                        break;
                    } else if (operationStatus === 'FAILED') {
                        logger.error(`Shopify bulk operation ${bulkOperationId} failed.`, { syncId, errorCode: pollResult.node.errorCode });
                        // Throw error to be caught by the outer catch block
                        throw new Error(`Shopify bulk operation failed with code: ${pollResult.node.errorCode}`);
                    } else if (operationStatus === 'CANCELED') {
                        logger.warn(`Shopify bulk operation ${bulkOperationId} was canceled.`, { syncId });
                         // Throw error to be caught by the outer catch block
                        throw new Error('Shopify bulk operation was canceled.');
                    }
                }

                if (operationStatus !== 'COMPLETED') {
                    logger.error(`Shopify bulk operation ${bulkOperationId} timed out after ${pollAttempts} attempts.`, { syncId });
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
                logger.warn('Skipping Shopify product download as no URL was obtained.', { syncId });
                 // Throw error to be caught by the outer catch block
                throw new Error('Failed to obtain download URL from Shopify bulk operation.');
            } else {
                logger.info(`Downloading Shopify product data from ${url}...`, { syncId });
                status.currentPhase = 'Downloading data'; // Already set, but good to be explicit
                status.progress = 45;
                syncStatus.set(syncId, status);
                try {
                    const response = await fetch(url);
                    if (!response.ok || !response.body) {
                        logger.error('Failed to download Shopify products file', { syncId, status: response.status, statusText: response.statusText });
                        throw new Error(`Failed to download Shopify products file: ${response.statusText}`);
                    }
                    await fs.mkdir(directoryPath, { recursive: true }); // Use fs.promises.mkdir
                    const fileWriteStream = fsSync.createWriteStream(fileName); // Use fs.createWriteStream
                     if (typeof Readable.fromWeb === 'function') {
                        const readableWebStream = Readable.fromWeb(response.body);
                        await pipeline(readableWebStream, fileWriteStream);
                     } else {
                         logger.warn('Readable.fromWeb not available. Stream piping might fail.', { syncId });
                         throw new Error('Node version too old for efficient stream handling from fetch response.');
                     }
                    logger.info(`Shopify product data downloaded successfully to ${fileName}`, { syncId });
                    status.progress = 50;
                    syncStatus.set(syncId, status);
                } catch (downloadError) {
                    logger.error('Error downloading or saving Shopify product data:', { syncId, error: downloadError });
                    throw downloadError; // Re-throw for main catch block
                }
            }
        }

        // --- Process downloaded data ---
        if (url && fileName) {
            logger.info(`Processing Shopify data from file: ${fileName}`, { syncId });
            status.currentPhase = 'Processing data';
            status.progress = 55;
            syncStatus.set(syncId, status);

            const fileReadStream = fsSync.createReadStream(fileName); // Use fsSync for streams
            const rl = readline.createInterface({
                input: fileReadStream,
                crlfDelay: Infinity
            });

            const allProducts = {};
            const variantToProductMap = {};
            let lineCount = 0;

            rl.on('line', (line) => {
                // ... (keep existing line processing logic) ...
                 lineCount++;
                 try {
                     if (!line.trim()) return;
                     const jsonLine = JSON.parse(line);
                     // --- Existing JSON processing logic ---
                     if (jsonLine.__parentId) {
                         const parentId = jsonLine.__parentId;
                         if (jsonLine.preview?.image || jsonLine.image) {
                             if (!allProducts[parentId]) { logger.warn(`Parent product ${parentId} not found for image line:`, { syncId, jsonLine }); return; }
                             const imageInfo = jsonLine.image || jsonLine.preview?.image;
                             if (imageInfo) { allProducts[parentId].images.push({ id: imageInfo.id, url: imageInfo.url, alt: imageInfo.altText || null }); }
                         } else if (jsonLine.location) {
                             const variantId = parentId;
                             const mapping = variantToProductMap[variantId];
                             if (mapping) {
                                 const { productId } = mapping;
                                 const product = allProducts[productId];
                                 const variant = product?.variants.find(v => v.id === variantId);
                                 if (variant) {
                                     if (!variant.inventoryLevels) variant.inventoryLevels = [];
                                     variant.inventoryLevels.push({ locationName: jsonLine.location.name, locationId: jsonLine.location.id });
                                 } else { logger.warn(`InventoryLevel line: Variant ${variantId} not found within Product ${productId}`, { syncId, line: jsonLine, productId, variantId }); }
                             } else { logger.error(`InventoryLevel line: Mapping not found for variant ID: ${variantId}.`, { syncId, line: jsonLine }); }
                         } else if (jsonLine.sku !== undefined) {
                             if (!allProducts[parentId]) { logger.warn(`Parent product ${parentId} not found for variant line:`, { syncId, jsonLine }); return; }
                             const variantData = { id: jsonLine.id, sku: jsonLine.sku, price: jsonLine.price, inventoryQuantity: jsonLine.inventoryQuantity, inventoryItemId: jsonLine.inventoryItem?.id, inventoryLevels: [] };
                             allProducts[parentId].variants.push(variantData);
                             const productId = parentId; const variantId = jsonLine.id; const inventoryItemId = jsonLine.inventoryItem?.id;
                             variantToProductMap[variantId] = { productId: productId, inventoryItemId: inventoryItemId };
                             if (!jsonLine.sku && !allProducts[parentId].ignore) { allProducts[parentId].ignore = "check sku"; }
                         } else { logger.warn("Unknown child object type in JSONL:", { syncId, jsonLine }); }
                     } else if (jsonLine.id && jsonLine.title) {
                         const productId = jsonLine.id;
                         allProducts[productId] = { id: productId, handle: jsonLine.handle, title: jsonLine.title, descriptionHtml: jsonLine.descriptionHtml, vendor: jsonLine.vendor, status: jsonLine.status, productType: jsonLine.productType, tags: jsonLine.tags || [], onlineStoreUrl: jsonLine.onlineStoreUrl, images: [], variants: [], ignore: false };
                         if (!(jsonLine.vendor === 'The Bearcub Book Den' || jsonLine.vendor === 'Sprinkles Studios')) { allProducts[productId].ignore = true; }
                     } else { logger.warn("Skipping unrecognized line in JSONL:", { syncId, line: line.substring(0, 100) }); }
                 } catch (parseError) {
                     logger.error(`Error parsing JSONL line ${lineCount}: ${parseError.message}`, { syncId, fileName, lineNumber: lineCount, lineContent: line.substring(0, 500) });
                 }
            });

            await new Promise((resolve, reject) => {
                rl.on('close', resolve);
                rl.on('error', reject);
                fileReadStream.on('error', reject);
            });

            logger.info(`Finished initial processing of ${fileName}. Processed ${lineCount} lines. Found ${Object.keys(allProducts).length} products.`, { syncId });
            status.syncCount = Object.keys(allProducts).length; // Update total count
            status.progress = 70;
            syncStatus.set(syncId, status);


            // --- Database Update Logic ---
            logger.info('Preparing database updates for Shopify products...', { syncId });
            status.currentPhase = 'Updating database';
            status.progress = 75;
            syncStatus.set(syncId, status);

            const bulkOps = [];
            const syncTimestamp = new Date();
            ignoreCount = 0; // Reset ignore count for this phase

            for (const productId in allProducts) {
                // ... (keep existing variant processing and bulkOps creation logic) ...
                 const shopifyProduct = allProducts[productId];
                 if (shopifyProduct.ignore === true) { ignoreCount++; continue; }
                 if (shopifyProduct.ignore === "check sku") { logger.warn(`Product "${shopifyProduct.title}" (${productId}) needs SKU check.`, { syncId }); continue; }
                 for (const variant of shopifyProduct.variants) {
                     if (!variant.sku) { logger.warn(`Skipping variant without SKU for product "${shopifyProduct.title}" (${productId}), variant ID ${variant.id}`, { syncId }); continue; }
                     bulkOps.push({
                         updateOne: {
                             filter: { sku: variant.sku },
                             update: {
                                 $set: {
                                     sku: variant.sku, name: shopifyProduct.title,
                                     'shopify_data.product_id': shopifyProduct.id, 'shopify_data.variant_id': variant.id, 'shopify_data.title': shopifyProduct.title, 'shopify_data.description': shopifyProduct.descriptionHtml, 'shopify_data.price': parseFloat(variant.price || 0), 'shopify_data.inventory_quantity': variant.inventoryQuantity, 'shopify_data.tags': shopifyProduct.tags, 'shopify_data.images': shopifyProduct.images.map(img => ({ url: img.url, alt: img.alt })), 'shopify_data.handle': shopifyProduct.handle, 'shopify_data.vendor': shopifyProduct.vendor, 'shopify_data.product_type': shopifyProduct.productType, 'shopify_data.status': shopifyProduct.status, 'shopify_data.last_synced': syncTimestamp,
                                     raw_shopify_data: { product: shopifyProduct, variant: variant, last_raw_sync: syncTimestamp },
                                     last_updated: syncTimestamp
                                 },
                                 $setOnInsert: { quantity_on_hand: variant.inventoryQuantity || 0, quantity_committed: 0 }
                             },
                             upsert: true
                         }
                     });
                 }
            }

            logger.info(`Prepared ${bulkOps.length} database update operations.`, { syncId });
            if (ignoreCount > 0) {
                 logger.info(`Ignored ${ignoreCount} products based on vendor or other criteria.`, { syncId });
            }
            status.syncCount = bulkOps.length; // Refine sync count to actual operations

            if (bulkOps.length > 0) {
                logger.info('Performing bulk write operation to database...', { syncId });
                status.progress = 85;
                syncStatus.set(syncId, status);
                try {
                    const result = await Product.bulkWrite(bulkOps);
                    logger.info('Database bulk write completed.', { syncId, upserted: result.upsertedCount, modified: result.modifiedCount, matched: result.matchedCount });
                    // Update status counts based on result
                    status.counts = { // Example counts, adjust as needed
                        added: result.upsertedCount,
                        updated: result.modifiedCount
                    };
                } catch (dbError) {
                    logger.error('Error during database bulk write:', { syncId, error: dbError });
                    throw dbError; // Re-throw for main catch block
                }
            } else {
                logger.info('No valid Shopify products found to update in the database.', { syncId });
                 status.counts = { added: 0, updated: 0 }; // Set counts to zero
            }
            status.progress = 95;
            syncStatus.set(syncId, status);
        } else {
             logger.info('Skipping database update because no Shopify data was downloaded or processed.', { syncId });
             // If we skipped download due to cache, we still need to mark as complete later
             if (url !== 'local') {
                 // If we didn't use local cache and didn't process, it implies an earlier error handled by throw
                 // If we *did* use local cache, we fall through to cleanup/completion
             }
        }

        // --- Data File Cleanup ---
        logger.info('Cleaning up old data files...', { syncId });
        status.currentPhase = 'Cleaning up';
        syncStatus.set(syncId, status);
        await cleanupDataFiles(directoryPath, filePrefix, 5);

        logger.info('Shopify product sync process finished successfully.', { syncId });
        status.progress = 100;
        status.complete = true;
        status.currentPhase = 'Complete';
        syncStatus.set(syncId, status);

        // Record successful sync time ONLY if the operation didn't fail early
        // Check if url is not null (meaning bulk op likely succeeded or we used cache)
        if (url) {
             await Settings.setSetting('lastShopifyProductSync', new Date().toISOString());
        }

    } catch (error) {
        // Main catch block for the entire function
        logger.error('Error during Shopify product sync process:', { syncId, error: error.message, stack: error.stack });

        // Update status with error details
        const finalStatus = syncStatus.get(syncId); // Get potentially updated status
        if (finalStatus) {
            finalStatus.complete = true;
            finalStatus.error = error.message || 'An unknown error occurred during Shopify sync.';
            finalStatus.progress = 100; // Mark as complete even on error
            syncStatus.set(syncId, finalStatus);
        } else {
            // This case should ideally not happen if initialization worked
            logger.error(`Could not find status object for ${syncId} to report final error.`);
        }

        // No req.flash here as this runs in the background

        // Ensure cleanup still runs if possible
        try {
            await cleanupDataFiles(directoryPath, filePrefix, 5);
        } catch (cleanupErr) {
            logger.error('Error during cleanup after sync failure:', { syncId, error: cleanupErr });
        }
    } finally {
        const overallEndTime = performance.now();
        logger.info(`[Perf] Overall syncShopifyProducts took ${(overallEndTime - overallStartTime).toFixed(2)}ms`, { syncId });
        // Optional: Clean up status map entry after some time if needed, similar to Etsy sync status route
        // setTimeout(() => { syncStatus.delete(syncId); }, 30 * 60 * 1000); // Example: 30 mins
    }
}

// Sync orders from specified marketplace
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

// Sync Etsy orders
async function syncEtsyOrders(req, res) {
    const overallStartTime = performance.now();
    let rateLimit429Count = 0;
    let requestTimings = [];
    try {
        logger.info('Starting Etsy order sync');
        const shopId = await getShopId();
        const tokenData = JSON.parse(process.env.TOKEN_DATA);
        const limit = 100;
        let allOrders = [];
        let newOrderCount = 0;
        let updatedOrderCount = 0;

        // Get last sync time and use a 1-day overlap
        let lastSyncTime = await Settings.getSetting('lastEtsyOrderSync');
        let minCreated;
        if (lastSyncTime) {
            const overlapMs = 24 * 60 * 60 * 1000; // 1 day overlap
            minCreated = Math.floor((new Date(lastSyncTime).getTime() - overlapMs) / 1000);
        } else {
            // Fallback to ORDER_SYNC_DAYS env or 90 days
            const orderSyncDays = parseInt(process.env.ORDER_SYNC_DAYS || '90', 10);
            minCreated = Math.floor((Date.now() - orderSyncDays * 24 * 60 * 60 * 1000) / 1000);
        }

        const headers = {
            'x-api-key': process.env.ETSY_API_KEY,
            'Authorization': `Bearer ${tokenData.access_token}`
        };

        // First, fetch the first page to get the total count
        const firstUrl = `${API_BASE_URL}/application/shops/${shopId}/receipts?limit=${limit}&offset=0&min_created=${minCreated}`;
        const reqStart = Date.now();
        logger.debug(`Fetching Etsy orders: ${firstUrl}`);
        let response = await etsyFetch(firstUrl, { headers });
        let reqDuration = Date.now() - reqStart;
        requestTimings.push(reqDuration);
        logger.info(`Fetched batch in ${reqDuration}ms (offset=0)`);
        if (response.status === 429) {
            rateLimit429Count++;
            logger.warn('Received HTTP 429 (Too Many Requests) from Etsy API', { offset: 0, url: firstUrl });
        }
        if (!response.ok) {
            const errorText = await response.text();
            logger.error('Failed to fetch Etsy orders', { status: response.status, error: errorText });
            throw new Error(`Failed to fetch Etsy orders: ${response.statusText}`);
        }
        const data = await response.json();
        const orders = data.results || [];
        allOrders.push(...orders);
        // Validate data.count before using for pagination
        let totalCount = (typeof data.count === 'number' && isFinite(data.count) && data.count > 0) ? data.count : orders.length;
        const totalPages = Math.ceil(totalCount / limit);

        if (orders.length < limit || totalPages <= 1) {
            logger.info(`Fetched ${allOrders.length} Etsy orders in date range (single page)`);
        } else if (totalPages > 10000) { // Arbitrary safety cap
            logger.error(`Unreasonable totalPages value: ${totalPages}. Aborting sync to prevent memory issues.`);
            throw new Error('Etsy API returned an unreasonable count for pagination.');
        } else {
            // Calculate total pages
            logger.info(`Etsy order sync: totalCount=${totalCount}, totalPages=${totalPages}`);
            // Prepare offsets for all remaining pages
            const offsets = [];
            for (let i = 1; i < totalPages; i++) {
                offsets.push(i * limit);
            }
            // Define fetchPage function for parallel workers
            async function fetchPage(offset) {
                let retries = 0;
                while (retries < 5) {
                    const url = `${API_BASE_URL}/application/shops/${shopId}/receipts?limit=${limit}&offset=${offset}&min_created=${minCreated}`;
                    const reqStart = Date.now();
                    try {
                        logger.debug(`Fetching Etsy orders: ${url}`);
                        let resp = await etsyFetch(url, { headers });
                        let reqDuration = Date.now() - reqStart;
                        requestTimings.push(reqDuration);
                        logger.info(`Fetched batch in ${reqDuration}ms (offset=${offset})`);
                        if (resp.status === 429) {
                            rateLimit429Count++;
                            logger.warn('Received HTTP 429 (Too Many Requests) from Etsy API', { offset, url });
                            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, retries))); // Exponential backoff
                            retries++;
                            continue;
                        }
                        if (!resp.ok) {
                            const errorText = await resp.text();
                            logger.error('Failed to fetch Etsy orders', { status: resp.status, error: errorText });
                            throw new Error(`Failed to fetch Etsy orders: ${resp.statusText}`);
                        }
                        const data = await resp.json();
                        return data.results || [];
                    } catch (err) {
                        logger.error('Error fetching Etsy orders page', { offset, error: err.message });
                        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, retries)));
                        retries++;
                    }
                }
                logger.error('Failed to fetch Etsy orders after retries', { offset });
                return [];
            }
            // Parallel fetch with concurrency pool pattern
            const CONCURRENCY = 5;
            let index = 0;
            const results = [];
            async function worker() {
                while (index < offsets.length) {
                    const myIndex = index++;
                    const offset = offsets[myIndex];
                    const res = await fetchPage(offset);
                    results.push(...res);
                }
            }
            await Promise.all(Array(CONCURRENCY).fill(0).map(() => worker()));
            allOrders.push(...results);
        }
        logger.info(`Fetched ${allOrders.length} Etsy orders in date range`);
        logger.info(`Etsy order sync: average request time = ${requestTimings.length ? (requestTimings.reduce((a, b) => a + b, 0) / requestTimings.length).toFixed(2) : 0}ms, 429s encountered: ${rateLimit429Count}`);

        // Prepare bulkWrite operations
        const bulkOps = [];
        const existingOrders = await Order.find({
            order_id: { $in: allOrders.map(o => o.receipt_id?.toString()) },
            marketplace: 'etsy'
        }).lean();
        const existingOrderMap = new Map(existingOrders.map(o => [o.order_id, o]));

        for (const etsyOrderData of allOrders) {
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
                transaction_id: tx.transaction_id?.toString()
            }));

            const update = {
                $set: {
                    etsy_order_data: etsyOrderData,
                    buyer_name: etsyOrderData.name || (existing?.buyer_name) || 'N/A',
                    order_date: orderDate,
                    receipt_id: receiptIdStr,
                    items
                }
            };

            // Use updateFromEtsy if available
            // (Assume updateFromEtsy is a method on the Order model instance, not usable here)

            bulkOps.push({
                updateOne: {
                    filter: { order_id: receiptIdStr, marketplace: 'etsy' },
                    update: update,
                    upsert: true
                }
            });
        }

        // Execute bulkWrite
        let result = { upsertedCount: 0, modifiedCount: 0 };
        if (bulkOps.length > 0) {
            result = await Order.bulkWrite(bulkOps, { ordered: false });
        }

        // Count new and updated orders
        newOrderCount = result.upsertedCount || 0;
        updatedOrderCount = result.modifiedCount || 0;

        logger.info(`Successfully synced ${newOrderCount} new and ${updatedOrderCount} existing Etsy orders`);
        req.flash('success', `Synced ${newOrderCount} new and ${updatedOrderCount} existing Etsy orders.`);

        // Record successful sync time in Settings
        await Settings.setSetting('lastEtsyOrderSync', new Date().toISOString());

        if (res) res.redirect('/sync');
    } catch (error) {
        logger.error('Error syncing Etsy orders:', { error: error.message, stack: error.stack });
        if (req && res) {
            req.flash('error', `Error syncing Etsy orders: ${error.message}`);
            res.redirect('/sync');
        }
    } finally {
        const overallEndTime = performance.now();
        logger.info(`[Perf] Overall syncEtsyOrders took ${(overallEndTime - overallStartTime).toFixed(2)}ms`);
    }
}

// Sync Shopify orders
async function syncShopifyOrders(req, res) {
    const overallStartTime = performance.now();
    try { // Outer try for initial setup
        // Check for the correct environment variables
        if (!process.env.SHOPIFY_ACCESS_TOKEN || !process.env.SHOPIFY_SHOP_NAME) {
            req.flash('error', 'Shopify credentials are not configured. Please connect your Shopify account in settings.');
            return res.redirect('/sync');
        }
        
        logger.info('Starting Shopify order sync');
        
        try { // Inner try for the main sync logic and API calls
            // Use shopify-helpers to get the client instead of creating a new one
            const shopify = shopifyHelpers.getShopifyClient();
            
            // Get date range for Order Sync Period from settings
            const orderSyncDays = parseInt(process.env.ORDER_SYNC_DAYS || 90, 10);
            const syncStartDate = new Date();
            syncStartDate.setDate(syncStartDate.getDate() - orderSyncDays);
            
            logger.info(`Using Order Sync Period of ${orderSyncDays} days from settings`);
            
            // Fetch orders from Shopify with pagination
            let newOrderCount = 0;
            let updatedOrderCount = 0;
            const newSkus = new Set();
            
            // Initial query params
            const params = {
                status: 'any',
                created_at_min: syncStartDate.toISOString(),
                limit: 250 // Shopify default is 50, max is 250
            };

            // Implement pagination to fetch all orders in the date range
            let allShopifyOrders = [];
            let hasMore = true;
            let lastId = null;
            while (hasMore) {
                const fetchParams = { ...params };
                if (lastId) fetchParams.since_id = lastId;
                const batch = await shopify.order.list(fetchParams);
                if (batch && batch.length > 0) {
                    allShopifyOrders.push(...batch);
                    lastId = batch[batch.length - 1].id;
                    hasMore = batch.length === params.limit;
                } else {
                    hasMore = false;
                }
            }
            logger.info(`Fetched ${allShopifyOrders.length} Shopify orders in date range`, { count: allShopifyOrders.length });
            // Use allShopifyOrders instead of shopifyOrders below
            // ...existing code...
            const processLoopStartTime = performance.now();
            for (const shopifyOrder of allShopifyOrders) {
                // Use order_id with Shopify order ID as the unique identifier
                let order = await Order.findOne({ 
                    marketplace: 'shopify', 
                    order_id: `shopify-${shopifyOrder.id.toString()}` 
                });
                
                const isNew = !order;
                
                if (!order) {
                    order = new Order({
                        order_id: `shopify-${shopifyOrder.id.toString()}`,
                        marketplace: 'shopify',
                        shopify_order_number: shopifyOrder.order_number?.toString() || shopifyOrder.name,
                        order_date: new Date(shopifyOrder.created_at),
                        buyer_name: `${shopifyOrder.customer?.first_name || ''} ${shopifyOrder.customer?.last_name || ''}`.trim(),
                        // Set a unique receipt_id for Shopify orders to avoid conflicts
                        receipt_id: `shopify-${shopifyOrder.id.toString()}`
                    });
                }
                
                // Update order items
                if (shopifyOrder.line_items && shopifyOrder.line_items.length > 0) {
                    order.items = shopifyOrder.line_items.map(item => {
                        const sku = item.sku || `SHOPIFY-${item.product_id}-${item.variant_id}`;
                        
                        // Check if this is a new SKU we haven't seen before
                        if (sku) {
                            newSkus.add({
                                sku,
                                product_id: item.product_id?.toString(),
                                variant_id: item.variant_id?.toString(),
                                title: item.title || item.name
                            });
                        }
                        
                        return {
                            marketplace: 'shopify',
                            line_item_id: item.id?.toString(),
                            product_id: item.product_id?.toString(),
                            variant_id: item.variant_id?.toString(),
                            sku,
                            quantity: item.quantity,
                            is_digital: item.requires_shipping === false
                        };
                    });
                }
                
                // Update order data using the helper method
                order.updateFromShopify(shopifyOrder);
                order.shopify_order_data = shopifyOrder;
                await order.save();
                
                if (isNew) newOrderCount++;
                else updatedOrderCount++;
            }
            const processLoopEndTime = performance.now();
            logger.info(`[Perf] Shopify order processing loop took ${(processLoopEndTime - processLoopStartTime).toFixed(2)}ms`, { new: newOrderCount, updated: updatedOrderCount });

            // Process new SKUs that are not already in the product database
            const existingSkus = await Product.distinct('sku', { 
                sku: { $in: Array.from(newSkus).map(item => item.sku) }
            });
            
            const skusToAdd = Array.from(newSkus).filter(item => !existingSkus.includes(item.sku));
            
            // Create new product entries for new SKUs
            if (skusToAdd.length > 0) {
                logger.info(`Found ${skusToAdd.length} new SKUs in Shopify orders to add to product database`);
                
                // Fetch product details for each new SKU
                const productDetails = new Map();
                
                for (const item of skusToAdd) {
                    if (item.product_id) {
                        try {
                            const productData = await shopify.product.get(item.product_id);
                            productDetails.set(item.sku, productData);
                        } catch (error) {
                            logger.warn(`Could not fetch Shopify product details for ${item.product_id}:`, { 
                                error: error.message 
                            });
                        }
                    }
                }
                
                // Create new product entries
                const productUpdates = skusToAdd.map(item => {
                    const productData = productDetails.get(item.sku);
                    let variantData = null;
                    
                    // Find the correct variant if we have product data
                    if (productData && item.variant_id) {
                        variantData = productData.variants.find(v => 
                            v.id.toString() === item.variant_id.toString()
                        );
                    }
                    
                    return {
                        updateOne: {
                            filter: { sku: item.sku },
                            update: {
                                $setOnInsert: {
                                    sku: item.sku,
                                    name: item.title || `Unknown Shopify Product (${item.sku})`,
                                    quantity_on_hand: 0,
                                    quantity_committed: 0
                                },
                                $set: {
                                    raw_shopify_data: productData ? {
                                        product: productData,
                                        inventory: null,
                                        last_raw_sync: new Date()
                                    } : null,
                                    shopify_data: productData ? {
                                        product_id: productData.id.toString(),
                                        variant_id: variantData?.id.toString(),
                                        title: productData.title,
                                        description: productData.body_html,
                                        handle: productData.handle,
                                        product_type: productData.product_type,
                                        vendor: productData.vendor,
                                        status: productData.status,
                                        price: parseFloat(variantData?.price || 0),
                                        inventory_quantity: parseInt(variantData?.inventory_quantity || 0, 10),
                                        tags: productData.tags ? productData.tags.split(',').map(tag => tag.trim()) : [],
                                        images: productData.images?.map(img => ({
                                            url: img.src,
                                            alt: img.alt || ''
                                        })) || [],
                                        last_synced: new Date()
                                    } : {
                                        product_id: item.product_id,
                                        variant_id: item.variant_id,
                                        title: item.title || `Unknown Shopify Product (${item.sku})`,
                                        last_synced: new Date()
                                    }
                                }
                            },
                            upsert: true
                        }
                    };
                });
                
                if (productUpdates.length > 0) {
                    const result = await Product.bulkWrite(productUpdates);
                    logger.info(`Added ${result.upsertedCount} new products from Shopify order SKUs`);
                    req.flash('success', `Added ${result.upsertedCount} new products from Shopify order SKUs`);
                }
            }
            
            const successMessage = `Successfully synced ${newOrderCount} new and ${updatedOrderCount} existing Shopify orders`;
            logger.info(successMessage);
            req.flash('success', successMessage);

            // Record successful sync time in Settings
            await Settings.setSetting('lastShopifyOrderSync', new Date().toISOString());

            res.redirect('/sync'); // Redirect back to sync page
            
        } catch (shopifyError) { // Catches errors during the Shopify API interaction/processing
            logger.error('Shopify API error during order sync:', { error: shopifyError.message });
            // Include the specific error message in the flash notification
            req.flash('error', `Failed to sync Shopify orders: ${shopifyError.message}`);
            res.redirect('/sync'); // Redirect back to sync page on API error
        }
    } catch (error) { // Catches errors from the outer try block (e.g., initial setup, client creation)
        logger.error('Error in Shopify order sync setup:', { error: error.message });
        // Include the specific error message in the flash notification
        req.flash('error', `Error starting Shopify order sync: ${error.message}`);
        res.redirect('/sync'); // Redirect back to sync page on setup error
    } finally {
        const overallEndTime = performance.now();
        logger.info(`[Perf] Overall syncShopifyOrders took ${(overallEndTime - overallStartTime).toFixed(2)}ms`);
    }
}

// Route to check sync status
router.get('/status/:syncId', (req, res) => {
    const syncId = req.params.syncId;
    const status = syncStatus.get(syncId) || {
        syncCount: 0,
        counts: {
            active: 0,
            draft: 0,
            expired: 0,
            inactive: 0,
            sold_out: 0
        },
        removedCount: 0,
        progress: 0,
        complete: false,
        error: null
    };
    
    console.log(`Status request for syncId ${syncId}:`, status);
    // Add processedCount and totalCount for frontend progress display
    status.processedCount = status.syncCount || 0;
    // Try to provide a real totalCount for product syncs
    if (status.counts && typeof status.counts === 'object') {
        // For product sync, try to sum all product states
        const total = Object.values(status.counts).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
        status.totalCount = total > 0 ? total : status.syncCount || 0;
    } else {
        status.totalCount = status.syncCount || 0;
    }
    // Always set processedCount and totalCount for frontend
    status.processedCount = typeof status.syncCount === 'number' ? status.syncCount : 0;
    if (status.counts && typeof status.counts === 'object') {
        if ('added' in status.counts || 'updated' in status.counts) {
            status.totalCount = 
                (typeof status.counts.added === 'number' ? status.counts.added : 0) +
                (typeof status.counts.updated === 'number' ? status.counts.updated : 0);
        } else {
            status.totalCount = Object.values(status.counts).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
        }
        if (!status.totalCount || status.totalCount < status.processedCount) {
            status.totalCount = status.processedCount;
        }
    } else {
        status.totalCount = status.processedCount;
    }
    res.json(status);
    
    // Clean up old status objects after 1 minutes
    if (status.complete) {
        setTimeout(() => {
            syncStatus.delete(syncId);
        }, 60 * 1000);
    }
});

module.exports = router;