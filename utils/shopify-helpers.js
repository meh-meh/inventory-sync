const Shopify = require('shopify-api-node');
const { logger } = require('./logger');

// Configuration
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

// Shopify client instance
let shopifyClient = null;

/**
 * Initialize the Shopify client
 * @returns {Shopify} - Shopify client instance
 */
function getShopifyClient() {
    if (!shopifyClient) {
        // Use SHOPIFY_SHOP_NAME for consistency with the rest of the application
        // but also check SHOPIFY_SHOP as a fallback for backward compatibility
        const shopName = process.env.SHOPIFY_SHOP_NAME || process.env.SHOPIFY_SHOP;
        
        if (!shopName || !process.env.SHOPIFY_ACCESS_TOKEN) {
            logger.error('Missing Shopify credentials in environment variables');
            throw new Error('Missing Shopify credentials. Set SHOPIFY_SHOP_NAME and SHOPIFY_ACCESS_TOKEN in environment variables.');
        }

        shopifyClient = new Shopify({
            shopName: shopName, // your-store.myshopify.com
            accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
            apiVersion: '2023-10', // Use the same API version as before
            autoLimit: true, // Automatically handle rate limits
            timeout: 30000, // Default timeout is 30 seconds
        });

        logger.info(`Shopify client initialized for shop: ${shopName}`);
    }
    return shopifyClient;
}

/**
 * Sleep/delay utility function
 * @param {Number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Enhanced API call with retries and error handling for Shopify API
 * @param {Function} apiCall - Function that returns a promise for the API call
 * @param {Number} retries - Number of retries remaining
 * @returns {Promise<any>} - API response
 */
async function withRetries(apiCall, retries = MAX_RETRIES) {
    const startTime = Date.now();
    
    try {
        const result = await apiCall();
        const requestTime = Date.now() - startTime;
        logger.debug(`Shopify API request completed in ${requestTime}ms`);
        return result;
    } catch (error) {
        // Handle rate limiting errors (429), which should be rare with autoLimit
        if (error.statusCode === 429 && retries > 0) {
            logger.warn(`Shopify rate limit exceeded despite autoLimit, retrying in ${RETRY_DELAY * 2}ms...`);
            await sleep(RETRY_DELAY * 5);
            return withRetries(apiCall, retries - 1);
        }
        
        // Handle authentication errors
        if (error.statusCode === 401) {
            logger.error('Shopify authentication failed');
            throw new Error('Shopify authentication failed');
        }
        
        // Handle other errors with retries
        if (retries > 0 && !error.message.includes('Authentication failed')) {
            const waitTime = RETRY_DELAY * (MAX_RETRIES - retries + 1); // Exponential backoff
            logger.warn(`Shopify request failed, retrying in ${waitTime}ms...`, { 
                error: error.message,
                statusCode: error.statusCode,
                requestId: error.requestId
            });
            await sleep(waitTime);
            return withRetries(apiCall, retries - 1);
        }
        
        // Log detailed error information
        logger.error('Shopify API error', {
            message: error.message,
            statusCode: error.statusCode,
            body: error.body,
            requestId: error.requestId
        });
        
        throw error;
    }
}

/**
 * Gets shop information from Shopify
 * @returns {Promise<Object>} - Shop information
 */
async function getShopInfo() {
    try {
        const client = getShopifyClient();
        return await withRetries(() => client.shop.get());
    } catch (error) {
        logger.error('Error getting Shopify shop info', { error: error.message });
        throw error;
    }
}

/**
 * Get all resources from paginated Shopify API endpoints
 * @param {Function} method - Shopify client method to call
 * @param {Object} params - Parameters for the API call
 * @returns {Promise<Array>} - All resources from all pages
 */
async function getAllResources(method, params = {}) {
    try {
        // Extract the resource name for logging
        let resourceName = 'resources';
        if (typeof method === 'object' && method.name) {
            resourceName = method.name;
        } else if (typeof method === 'function') {
            resourceName = method.name || 'resources';
        }
        
        logger.debug(`Fetching all Shopify ${resourceName} with params:`, params);
        
        // The issue is here: we can't directly use method.call as it assumes method is a function
        // but it's actually an object with methods like list, count, etc.
        let result;
        
        // Handle different types of method references
        if (typeof method === 'object' && method.list) {
            // If it's a shopify.order object with a list method
            result = await withRetries(() => method.list(params));
        } else if (typeof method === 'function') {
            // If it's a direct function reference
            result = await withRetries(() => method(params));
        } else {
            throw new Error('Invalid method provided to getAllResources');
        }
        
        logger.info(`Retrieved ${result.length} Shopify ${resourceName}`);
        return result;
    } catch (error) {
        logger.error(`Error getting all Shopify resources`, { 
            resourceMethod: typeof method === 'object' ? (method.name || 'unknown') : 'unknown',
            error: error.message 
        });
        throw error;
    }
}

/**
 * Batch process Shopify API requests to prevent rate limiting
 * @param {Array<Function>} requests - Array of functions that return promises
 * @param {Number} batchSize - Number of requests to process in each batch
 * @returns {Promise<Array>} - Results of all requests
 */
async function batchProcess(requests, batchSize = 5) {
    const results = [];
    
    // Process in batches to avoid overwhelming the API
    for (let i = 0; i < requests.length; i += batchSize) {
        const batch = requests.slice(i, i + batchSize);
        logger.info(`Processing Shopify batch ${Math.floor(i/batchSize) + 1} of ${Math.ceil(requests.length/batchSize)} (${batch.length} requests)`);
        
        // Process batch in parallel, but with rate limiting applied to each request
        const batchResults = await Promise.all(batch.map(requestFn => withRetries(requestFn)));
        results.push(...batchResults);
        
        // Add a small delay between batches
        if (i + batchSize < requests.length) {
            await sleep(500);
        }
    }
    
    return results;
}

// Build a clean API_BASE_URL based on the shop and API version
const API_BASE_URL = `https://${process.env.SHOPIFY_SHOP_NAME || process.env.SHOPIFY_SHOP}/admin/api/2023-10`;

module.exports = {
    getShopifyClient,
    getShopInfo,
    getAllResources,
    batchProcess,
    sleep,
    withRetries,
    API_BASE_URL
};