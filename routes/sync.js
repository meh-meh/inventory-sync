const express = require('express');
const router = express.Router();
const Product = require('../models/product');
const Order = require('../models/order');
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

// In-memory store for sync status
const syncStatus = new Map();

// Sync dashboard
router.get('/', async (req, res) => {
    try {
        const [
            totalProducts,
            productsWithEtsy,
            productsWithShopify,
            lastEtsySync,
            lastShopifySync
        ] = await Promise.all([
            Product.countDocuments(),
            Product.countDocuments({ 'etsy_data.listing_id': { $exists: true } }),
            Product.countDocuments({ 'shopify_data.product_id': { $exists: true } }),
            Product.findOne({ 'etsy_data.last_synced': { $exists: true } })
                .sort({ 'etsy_data.last_synced': -1 })
                .select('etsy_data.last_synced'),
            Product.findOne({ 'shopify_data.last_synced': { $exists: true } })
                .sort({ 'shopify_data.last_synced': -1 })
                .select('shopify_data.last_synced')
        ]);

        res.render('sync', {
            stats: {
                totalProducts,
                productsWithEtsy,
                productsWithShopify,
                lastEtsySync: lastEtsySync?.etsy_data?.last_synced,
                lastShopifySync: lastShopifySync?.shopify_data?.last_synced
            }
        });
    } catch (error) {
        console.error('Error fetching sync dashboard:', error);
        req.flash('error', 'Error loading sync dashboard');
        res.redirect('/');
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

            // Use etsyFetch instead of the undefined rateLimitedFetch
            const response = await etsyFetch(
                `https://openapi.etsy.com/v3/application/shops/${shop_id}/listings?${urlencoded.toString()}`,
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
            const progressValue = 10 + Math.round((i / states.length) * 15) + 
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
    try {
        await syncShopifyProducts(req);
        res.json({ success: true, message: 'Shopify sync started successfully' });
    } catch (error) {
        logger.error('Error starting Shopify sync:', { error: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
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
      const files = await fs.promises.readdir(dirPath);
  
      if (files.length === 0) {
        return null; // Return null if the directory is empty
      }
  
      const filesWithStats = await Promise.all(
        files.map(async (file) => {
          const filePath = path.join(dirPath, file);
          const stats = await fs.promises.stat(filePath);
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
        const files = await fs.promises.readdir(directoryPath);
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
                    await fs.promises.unlink(file.path);
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

async function syncShopifyProducts(req) {
    const directoryPath = path.resolve(__dirname, '..', 'data');
    const filePrefix = 'shopify_products_';
    let fileName = path.resolve(directoryPath, `${filePrefix}${Date.now()}.jsonl`);
    let url = null; // Define url here to be accessible later

    const allProducts = {};
    let ignoreCount = 0;
    let bulkOperationId = null; // To store the bulk operation ID

    try { // Wrap the main logic in a try...catch
        const existingData = await getNewestFile(directoryPath); // Assuming getNewestFile handles errors

        if (existingData && existingData.startsWith(filePrefix) && path.parse(existingData).name.split('_').pop() > Date.now() - 1000 * 60 * 60 * 2) { // Check if the file is less than 2 hours old
            logger.info(`Using existing data file: ${existingData}`);
            fileName = path.resolve(directoryPath, existingData);
        } else { // If the file is older than 2 hours, fetch new data
            logger.info('Existing data file is old or missing, fetching new data from Shopify...');
            const shopify = shopifyHelpers.getShopifyClient();

            const query = `mutation {
                bulkOperationRunQuery(
                    query: """
                        {
                            products {
                                edges {
                                    node {
                                        id
                                        handle # Added handle
                                        title
                                        descriptionHtml
                                        vendor
                                        status
                                        productType # Added productType
                                        tags
                                        onlineStoreUrl
                                        media(first: 10) { # Limit media items
                                            edges {
                                                node {
                                                    preview { # Get preview image for simplicity
                                                        image {
                                                            url
                                                            altText # Use altText
                                                        }
                                                    }
                                                    ... on MediaImage {
                                                        image {
                                                            id # Need image ID for potential linking
                                                            url
                                                            altText
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        variants(first: 50) { # Limit variants
                                            edges {
                                                node {
                                                    id
                                                    sku
                                                    price # Added price
                                                    inventoryQuantity
                                                    inventoryItem {
                                                        id # Need inventory item ID
                                                        inventoryLevels(first: 10) { # Limit locations
                                                            edges {
                                                                node {
                                                                    availableQuantity # <-- ADD THIS LINE
                                                                    location {
                                                                        id
                                                                        name
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    """
                ) {
                    bulkOperation {
                        id
                        status
                    }
                    userErrors {
                        field
                        message
                    }
                }
            `;

            try {
                logger.info('Requesting Shopify bulk product export...');
                const initialResult = await shopify.graphql(query);

                if (initialResult.userErrors && initialResult.userErrors.length > 0) {
                    logger.error('Shopify bulk operation user errors:', initialResult.userErrors);
                    throw new Error(`Shopify user errors: ${initialResult.userErrors.map(e => e.message).join(', ')}`);
                }

                if (!initialResult.bulkOperationRunQuery || !initialResult.bulkOperationRunQuery.bulkOperation) {
                     logger.error('Unexpected response from Shopify bulk operation initiation:', initialResult);
                     throw new Error('Failed to initiate Shopify bulk operation.');
                }

                bulkOperationId = initialResult.bulkOperationRunQuery.bulkOperation.id;
                let status = initialResult.bulkOperationRunQuery.bulkOperation.status;
                logger.info(`Shopify bulk operation started. ID: ${bulkOperationId}, Status: ${status}`);


                // Polling for completion using async/await
                const queryJob = `query {
                    node(id: "${bulkOperationId}") {
                       ... on BulkOperation {
                            id
                            status
                            errorCode
                            createdAt
                            completedAt
                            objectCount
                            fileSize
                            url
                            partialDataUrl
                        }
                    }
                }`;

                const MAX_POLL_ATTEMPTS = 60; // Poll for max 5 minutes (60 attempts * 5 seconds)
                const POLL_INTERVAL_MS = 5000; // 5 seconds
                let pollAttempts = 0;

                while (pollAttempts < MAX_POLL_ATTEMPTS) {
                    pollAttempts++;
                    await shopifyHelpers.sleep(POLL_INTERVAL_MS); // Use helper sleep

                    logger.debug(`Polling Shopify bulk operation status (Attempt ${pollAttempts})...`);
                    const pollResult = await shopify.graphql(queryJob);

                    if (!pollResult.node) {
                         logger.warn(`Bulk operation ${bulkOperationId} not found during polling.`);
                         // Decide how to handle: retry, fail, etc. Maybe wait longer?
                         continue; // Continue polling for now
                    }

                    status = pollResult.node.status;
                    logger.debug(`Bulk operation status: ${status}`);

                    if (status === 'COMPLETED') {
                        url = pollResult.node.url;
                        logger.info(`Shopify bulk operation ${bulkOperationId} completed successfully. URL: ${url}`);
                        break; // Exit loop
                    } else if (status === 'FAILED') {
                        logger.error(`Shopify bulk operation ${bulkOperationId} failed.`, { errorCode: pollResult.node.errorCode });
                        throw new Error(`Shopify bulk operation failed with code: ${pollResult.node.errorCode}`);
                    } else if (status === 'CANCELED') {
                         logger.warn(`Shopify bulk operation ${bulkOperationId} was canceled.`);
                         throw new Error('Shopify bulk operation was canceled.');
                    }
                    // Continue loop if status is CREATED or RUNNING
                }

                if (status !== 'COMPLETED') {
                    logger.error(`Shopify bulk operation ${bulkOperationId} timed out after ${pollAttempts} attempts.`);
                    throw new Error('Shopify bulk operation timed out.');
                }

            } catch (err) {
                logger.error('Error during Shopify bulk operation:', err);
                throw err; // Re-throw to be caught by outer try...catch
            }


            if (!url) {
                 throw new Error('Bulk operation completed but no download URL was found.');
            }

            logger.info(`Downloading Shopify product data from ${url}...`);
            try {
                const response = await fetch(url); // Use global fetch

                if (!response.ok || !response.body) {
                    logger.error('Failed to download Shopify products file', { status: response.status, statusText: response.statusText });
                    throw new Error(`Failed to download Shopify products file: ${response.statusText}`);
                }

                // Ensure directory exists
                await fs.promises.mkdir(directoryPath, { recursive: true });

                const fileWriteStream = fs.createWriteStream(fileName);
                // Use Readable.fromWeb for Node 18+ compatibility
                 if (typeof Readable.fromWeb === 'function') {
                    const readableWebStream = Readable.fromWeb(response.body);
                    await pipeline(readableWebStream, fileWriteStream);
                 } else {
                    // Fallback for older Node versions (might need polyfill or different approach)
                    // For simplicity, assuming Node 18+ for now. Add compatibility if needed.
                     logger.warn('Readable.fromWeb not available. Stream piping might fail.');
                     // A potential fallback (less efficient):
                     // const buffer = await response.arrayBuffer();
                     // await fs.promises.writeFile(fileName, Buffer.from(buffer));
                     throw new Error('Node version too old for efficient stream handling from fetch response.');
                 }


                logger.info(`Shopify product data downloaded successfully to ${fileName}`);
            } catch (downloadError) {
                logger.error('Error downloading or saving Shopify product data:', downloadError);
                throw downloadError; // Re-throw
            }
        }

        // Read the JSONL file and process each line
        logger.info(`Processing Shopify data from file: ${fileName}`);
        const fileReadStream = fs.createReadStream(fileName);
        const rl = readline.createInterface({
            input: fileReadStream,
            crlfDelay: Infinity
        });

        const variantToProductMap = {}; // Map: variantId -> { productId, inventoryItemId }
        // REMOVED: const inventoryItemToVariantMap = {}; // Map: inventoryItemId -> { variantId, productId }

        rl.on('line', (line) => {
            try {
                const jsonLine = JSON.parse(line);

                if (jsonLine.__parentId) {
                    // --- Child Object Processing ---
                    const parentId = jsonLine.__parentId;

                    if (jsonLine.preview?.image || jsonLine.image) {
                        // Line is an image (media) - Parent MUST be a Product
                        if (!allProducts[parentId]) {
                            logger.warn(`Parent product ${parentId} not found for image line:`, jsonLine);
                            return; // Skip processing this line
                        }
                        const imageInfo = jsonLine.image || jsonLine.preview?.image;
                        if (imageInfo) {
                            allProducts[parentId].images.push({
                                id: imageInfo.id,
                                url: imageInfo.url,
                                alt: imageInfo.altText || null
                            });
                        }
                    } else if (jsonLine.location) {
                        // Line is an inventory level - Parent MUST be a ProductVariant
                        const variantId = parentId; // Parent ID is the Variant ID
                        const mapping = variantToProductMap[variantId]; // Use variantToProductMap

                        if (mapping) {
                            // Mapping found, process immediately
                            const { productId } = mapping; // Get productId from the map
                            const product = allProducts[productId];
                            // Find the variant using the variantId (which is parentId)
                            const variant = product?.variants.find(v => v.id === variantId);

                            if (variant) {
                                if (!variant.inventoryLevels) {
                                    variant.inventoryLevels = [];
                                }
                                variant.inventoryLevels.push({
                                    locationName: jsonLine.location.name,
                                    locationId: jsonLine.location.id,
                                    quantity: jsonLine.availableQuantity // Ensure quantity is captured
                                });
                            } else {
                                // This case might happen if the product itself wasn't processed correctly earlier
                                logger.warn(`InventoryLevel line: Variant ${variantId} not found within Product ${productId}, although mapping exists.`, { line: jsonLine, productId, variantId });
                            }
                        } else {
                            // Mapping not found - This indicates a potential issue with JSONL order or processing logic.
                            logger.error(`InventoryLevel line: Mapping not found for variant ID: ${variantId}. This indicates a potential issue with JSONL order or processing logic.`, { line: jsonLine });
                        }
                    } else if (jsonLine.sku !== undefined) {
                        // Line is a variant - Parent MUST be a Product
                        if (!allProducts[parentId]) {
                            logger.warn(`Parent product ${parentId} not found for variant line:`, jsonLine);
                            return; // Skip processing this line
                        }

                        const variantData = {
                            id: jsonLine.id,
                            sku: jsonLine.sku,
                            price: jsonLine.price,
                            inventoryQuantity: jsonLine.inventoryQuantity,
                            inventoryItemId: jsonLine.inventoryItem?.id,
                            inventoryLevels: [] // Initialize inventoryLevels array
                        };
                        allProducts[parentId].variants.push(variantData);

                        // Populate maps
                        const productId = parentId;
                        const variantId = jsonLine.id;
                        const inventoryItemId = jsonLine.inventoryItem?.id;

                        variantToProductMap[variantId] = { productId: productId, inventoryItemId: inventoryItemId };
                        // REMOVED: if (inventoryItemId) { inventoryItemToVariantMap[inventoryItemId] = { variantId: variantId, productId: productId }; }

                        if (!jsonLine.sku && !allProducts[parentId].ignore) {
                            allProducts[parentId].ignore = "check sku";
                        }
                    } else {
                        logger.warn("Unknown child object type in JSONL:", jsonLine);
                    }
                } else if (jsonLine.id && jsonLine.title) {
                    // --- Product Object Processing ---
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
                        ignore: false
                    };
                    if (!(jsonLine.vendor === 'The Bearcub Book Den' || jsonLine.vendor === 'Sprinkles Studios')) {
                        allProducts[productId].ignore = true;
                    }
                } else {
                    logger.warn("Skipping unrecognized line in JSONL:", line);
                }
            } catch (parseError) {
                logger.error(`Error parsing JSONL line: ${parseError.message}`, { line });
            }
        });

        await new Promise((resolve, reject) => {
            rl.on('close', resolve);
            rl.on('error', reject); // Handle errors during read stream
            fileReadStream.on('error', reject); // Handle file stream errors
        });

        logger.info(`Finished initial processing of ${fileName}. Found ${Object.keys(allProducts).length} products.`);


        // --- Database Update Logic ---
        logger.info('Preparing database updates for Shopify products...');
        const bulkOps = [];
        const syncTimestamp = new Date();

        for (const productId in allProducts) {
            const shopifyProduct = allProducts[productId];

            if (shopifyProduct.ignore === true) {
                ignoreCount++;
                continue; // Skip ignored products
            }

            if (shopifyProduct.ignore === "check sku") {
                // TODO: Handle 'check sku' logic separately if needed
                logger.warn(`Product "${shopifyProduct.title}" (${productId}) needs SKU check.`);
                // For now, we'll skip updating these in the main sync
                continue;
            }

            // Process variants for this product
            for (const variant of shopifyProduct.variants) {
                if (!variant.sku) {
                    logger.warn(`Skipping variant without SKU for product "${shopifyProduct.title}" (${productId}), variant ID ${variant.id}`);
                    continue; // Skip variants without SKUs
                }

                // Prepare the update operation for this variant's SKU
                bulkOps.push({
                    updateOne: {
                        filter: { sku: variant.sku },
                        update: {
                            $set: {
                                sku: variant.sku, // Ensure SKU is set
                                name: shopifyProduct.title, // Use product title as base name
                                // Update shopify_data subdocument
                                'shopify_data.product_id': shopifyProduct.id,
                                'shopify_data.variant_id': variant.id,
                                'shopify_data.title': shopifyProduct.title, // Consider variant title if available
                                'shopify_data.description': shopifyProduct.descriptionHtml,
                                'shopify_data.price': parseFloat(variant.price || 0),
                                'shopify_data.inventory_quantity': variant.inventoryQuantity, // Use variant quantity
                                'shopify_data.tags': shopifyProduct.tags,
                                'shopify_data.images': shopifyProduct.images.map(img => ({ url: img.url, alt: img.alt })), // Map images
                                'shopify_data.handle': shopifyProduct.handle,
                                'shopify_data.vendor': shopifyProduct.vendor,
                                'shopify_data.product_type': shopifyProduct.productType,
                                'shopify_data.status': shopifyProduct.status,
                                'shopify_data.last_synced': syncTimestamp,
                                // Update raw_shopify_data as a whole object to avoid issues with null parent
                                raw_shopify_data: {
                                    product: shopifyProduct, // Store processed product structure
                                    variant: variant, // Store processed variant structure
                                    last_raw_sync: syncTimestamp
                                },
                                last_updated: syncTimestamp
                            },
                            $setOnInsert: {
                                // Set initial quantity_on_hand if this is a new product record
                                // This might need refinement based on how you manage overall quantity
                                quantity_on_hand: variant.inventoryQuantity || 0,
                                quantity_committed: 0 // Default committed to 0
                            }
                        },
                        upsert: true // Create product if SKU doesn't exist
                    }
                });
            }
        }

        logger.info(`Prepared ${bulkOps.length} database update operations.`);
        if (ignoreCount > 0) {
             logger.info(`Ignored ${ignoreCount} products based on vendor or other criteria.`);
        }

        // Perform bulk update
        if (bulkOps.length > 0) {
            logger.info('Performing bulk write operation to database...');
            try {
                const result = await Product.bulkWrite(bulkOps);
                logger.info('Database bulk write completed.', {
                    upserted: result.upsertedCount,
                    modified: result.modifiedCount,
                    matched: result.matchedCount
                });
                 // Optionally add flash message for success
                 if (req.flash) { // Check if flash is available (might not be in background task)
                     req.flash('success', `Shopify sync complete: ${result.upsertedCount} new products/variants added, ${result.modifiedCount} updated.`);
                 }
            } catch (dbError) {
                logger.error('Error during database bulk write:', dbError);
                throw dbError; // Re-throw
            }
        } else {
            logger.info('No valid Shopify products found to update in the database.');
             if (req.flash) {
                 req.flash('info', 'Shopify sync ran, but no products needed updating in the database.');
             }
        }

        // --- Data File Cleanup ---
        await cleanupDataFiles(directoryPath, filePrefix, 5); // Keep latest 5 files

        logger.info('Shopify product sync process finished successfully.');

    } catch (error) {
        logger.error('Error during Shopify product sync process:', error);
         if (req.flash) {
             req.flash('error', `Shopify sync failed: ${error.message}`);
         }
        // Re-throw or handle error appropriately for the calling context (e.g., return error response)
        throw error; // Make sure the caller knows about the failure
    }


    // TODO: Clean up data folder to remove old jsonl files. This should be some reasonable limit like 10 files or 100MB of data. - DONE

    // Future improvement:
    //      Check the products where ignore is set to "check sku" (checkSkuProducts) and see if there are any close matches to the Etsy products in the database.
    //      If so, add them to the database with a note that they need to be checked and which Etsy product they are a match for.
    //      Follow that up with a new landing page to show the products that need to be checked, what record they are a good match for, and a button to approve the link.
    //      Future future improvement: add a way to find the correct product to link it to.
    //      Eventually, if two products are linked but skus are different betweeen Shopify and Etsy, add a way to select which sku is correct (or manually enter a new one) and update the other store with the new sku.
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
    try {
        logger.info('Starting Etsy order sync');
        const shopId = await getShopId();
        const tokenData = JSON.parse(process.env.TOKEN_DATA);
        const orderSyncDays = parseInt(process.env.ORDER_SYNC_DAYS || '90', 10);
        const minCreated = Math.floor((Date.now() - orderSyncDays * 24 * 60 * 60 * 1000) / 1000);

        let offset = 0;
        const limit = 100;
        let allOrders = [];
        let newOrderCount = 0;
        let updatedOrderCount = 0;

        const headers = {
            'x-api-key': process.env.ETSY_API_KEY,
            'Authorization': `Bearer ${tokenData.access_token}`
        };

        const fetchLoopStartTime = performance.now();
        while (true) {
            const iterationStartTime = performance.now();
            // Use imported API_BASE_URL
            const url = `${API_BASE_URL}/application/shops/${shopId}/receipts?limit=${limit}&offset=${offset}&min_created=${minCreated}`;
            logger.debug(`Fetching Etsy orders: ${url}`);
            
            // Use etsyFetch instead of rateLimitedFetch
            const response = await etsyFetch(url, { headers });

            if (!response.ok) {
                const errorText = await response.text();
                logger.error('Failed to fetch Etsy orders', { status: response.status, error: errorText });
                throw new Error(`Failed to fetch Etsy orders: ${response.statusText}`);
            }

            const data = await response.json();
            const orders = data.results || [];
            allOrders.push(...orders);

            const iterationEndTime = performance.now();
            logger.debug(`[Perf] Etsy order fetch iteration took ${(iterationEndTime - iterationStartTime).toFixed(2)}ms`);
            if (orders.length < limit) {
                break;
            }
            offset += limit;
        }
        const fetchLoopEndTime = performance.now();
        logger.info(`[Perf] Etsy order fetch loop took ${(fetchLoopEndTime - fetchLoopStartTime).toFixed(2)}ms`, { count: allOrders.length });

        // Process orders
        const processLoopStartTime = performance.now();
        for (const etsyOrderData of allOrders) {
            const orderProcessStartTime = performance.now();
            const receiptIdStr = etsyOrderData.receipt_id?.toString();

            // Basic check for receipt_id
            if (!receiptIdStr) {
                logger.warn('Skipping Etsy order due to missing receipt_id', { orderData: etsyOrderData });
                continue;
            }

            try {
                let order = await Order.findOne({ order_id: receiptIdStr, marketplace: 'etsy' });
                let isNewOrder = false;
                if (!order) {
                    isNewOrder = true;

                    // Validate created_timestamp before creating Date (Corrected field name)
                    const timestamp = etsyOrderData.created_timestamp; // Corrected field name
                    // Add the actual timestamp value to the log context
                    if (typeof timestamp !== 'number' || timestamp <= 0) {
                        logger.warn('Skipping new Etsy order due to invalid created_timestamp type or value', { // Corrected log message
                            receipt_id: receiptIdStr, 
                            timestamp_value: timestamp, // Include the value
                            timestamp_type: typeof timestamp // Include the type
                        });
                        continue; // Skip this order
                    }

                    const orderDate = new Date(timestamp * 1000);
                    // Add the actual timestamp value to the log context
                    if (isNaN(orderDate.getTime())) {
                        logger.warn('Skipping new Etsy order due to invalid date conversion from created_timestamp', { // Corrected log message
                            receipt_id: receiptIdStr, 
                            timestamp_value: timestamp // Include the value
                        });
                        continue; // Skip this order
                    }

                    order = new Order({
                        order_id: receiptIdStr,
                        marketplace: 'etsy',
                        order_date: orderDate, // Use validated date
                        receipt_id: receiptIdStr,
                        buyer_name: etsyOrderData.name || 'N/A'
                    });
                    newOrderCount++;
                }

                // Update common fields and Etsy-specific data
                order.etsy_order_data = etsyOrderData; // Store raw data
                order.buyer_name = etsyOrderData.name || order.buyer_name || 'N/A'; // Update buyer name, keep existing if new one is missing
                
                // Update status using the method
                order.updateFromEtsy(etsyOrderData);

                // Update items (ensure transactions exist)
                order.items = (etsyOrderData.transactions || []).map(tx => ({
                    marketplace: 'etsy',
                    sku: tx.sku || 'UNKNOWN', // Use SKU if available
                    quantity: tx.quantity,
                    is_digital: tx.is_digital,
                    receipt_id: receiptIdStr,
                    listing_id: tx.listing_id?.toString(),
                    transaction_id: tx.transaction_id?.toString()
                }));

                await order.save();
                
                if (!isNewOrder) {
                    updatedOrderCount++; 
                }
                
            } catch (validationError) {
                // Catch potential validation errors during save and log context
                logger.error('Validation error processing Etsy order', { 
                    receipt_id: receiptIdStr, 
                    error: validationError.message, 
                    stack: validationError.stack 
                });
                // Optionally continue to next order instead of stopping the whole sync
                // continue; 
            }
            
            const orderProcessEndTime = performance.now();
            logger.debug(`[Perf] Etsy order processing took ${(orderProcessEndTime - orderProcessStartTime).toFixed(2)}ms`, { receipt_id: receiptIdStr });
        }
        const processLoopEndTime = performance.now();
        logger.info(`[Perf] Etsy order processing loop took ${(processLoopEndTime - processLoopStartTime).toFixed(2)}ms`, { new: newOrderCount, updated: updatedOrderCount });

        logger.info(`Successfully synced ${newOrderCount} new and ${updatedOrderCount} existing Etsy orders`);
        req.flash('success', `Synced ${newOrderCount} new and ${updatedOrderCount} existing Etsy orders.`);
        // Check if res is available before redirecting
        if (res) {
            res.redirect('/sync');
        }

    } catch (error) {
        logger.error('Error syncing Etsy orders:', { error: error.message, stack: error.stack }); // Log stack trace
        // Check if req and res are available before flashing/redirecting
        if (req && res) {
            req.flash('error', 'Error syncing Etsy orders');
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
    try {
        // Check for the correct environment variables
        if (!process.env.SHOPIFY_ACCESS_TOKEN || !process.env.SHOPIFY_SHOP_NAME) {
            req.flash('error', 'Shopify credentials are not configured. Please connect your Shopify account in settings.');
            return res.redirect('/sync');
        }
        
        logger.info('Starting Shopify order sync');
        
        try {
            // Use shopify-helpers to get the client instead of creating a new one
            const shopifyHelpers = require('../utils/shopify-helpers');
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
            
            // Use getAllResources helper with the correct method reference
            const shopifyOrders = await shopifyHelpers.getAllResources(shopify.order, params);
            
            // Process each Shopify order
            const processLoopStartTime = performance.now();
            for (const shopifyOrder of shopifyOrders) {
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
            res.redirect('/orders?marketplace=shopify');
            
        } catch (shopifyError) {
            logger.error('Shopify API error during order sync:', { error: shopifyError.message });
            req.flash('error', `Failed to sync Shopify orders: ${shopifyError.message}`);
            res.redirect('/orders');
        }
    } catch (error) {
        logger.error('Error in Shopify order sync:', { error: error.message });
        req.flash('error', `Error syncing orders from Shopify: ${error.message}`);
        res.redirect('/orders');
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
    res.json(status);
    
    // Clean up old status objects after 30 minutes
    if (status.complete) {
        setTimeout(() => {
            syncStatus.delete(syncId);
        }, 30 * 60 * 1000);
    }
});

module.exports = router;