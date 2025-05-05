const fetch = require('node-fetch');
const dotenv = require('@dotenvx/dotenvx');
// Correctly import only logger
const { logger } = require('./logger');
const authService = require('./auth-service');
const { sleep } = require('./shopify-helpers'); // Import sleep
const { etsyRequest } = require('./etsy-request-pool'); // Import etsyRequest

// Configuration
const API_BASE_URL = 'https://openapi.etsy.com/v3';
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

// Define trackRateLimit function *before* etsyFetch
let lastRequestTime = 0;
const rateLimitDelay = 100; // 100ms between requests (10 req/sec)

/**
 * Ensures requests do not exceed the Etsy rate limit (10 req/sec).
 * @returns {Promise<void>}
 */
async function trackRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < rateLimitDelay) {
        await sleep(rateLimitDelay - timeSinceLastRequest); // Use imported sleep
    }
    lastRequestTime = Date.now();
}

/**
 * Enhanced fetch with retries, rate limiting, and error handling for Etsy API
 * @param {String} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {Number} retries - Number of retries remaining
 * @returns {Promise<Response>} - Fetch response
 */
async function etsyFetch(url, options, retries = MAX_RETRIES) {
    await trackRateLimit(); // Call the local function defined above

    let response; // Define response outside try block to access in catch/finally
    try {
        response = await fetch(url, options);

        // Log rate limit headers
        const remaining = response.headers.get('x-ratelimit-remaining');
        const limit = response.headers.get('x-ratelimit-limit');
        if (remaining && limit) {
            logger.debug(`Rate limit: ${remaining}/${limit} remaining`);
        }

        // Handle common error cases
        if (response.status === 429) { // Rate limit exceeded
            if (retries > 0) {
                logger.warn(`Rate limit exceeded, retrying in ${RETRY_DELAY}ms...`);
                await sleep(RETRY_DELAY);
                return etsyFetch(url, options, retries - 1);
            }
            throw new Error('Rate limit exceeded and max retries reached');
        }

        if (response.status === 401) {
            const tokenExpired = authService.isTokenExpired();
            if (tokenExpired && retries > 0) {
                logger.warn('Token expired, attempting refresh and retry...');
                await authService.refreshToken();
                // Update authorization header with new token
                if (options.headers && options.headers.Authorization) {
                    options.headers.Authorization = `Bearer ${authService.getAccessToken()}`;
                }
                return etsyFetch(url, options, retries - 1);
            }
            logger.error('Authentication failed - unable to refresh token');
            throw new Error('Authentication failed');
        }

        if (!response.ok) {
            let errorData = null;
            let errorText = ''; // Store raw text
            try {
                // Clone the response to read it multiple times if needed
                const clonedResponse = response.clone();
                errorText = await clonedResponse.text(); // Read raw text first
                try {
                    // Attempt to parse the original response as JSON
                    errorData = await response.json();
                } catch (jsonError) {
                    // If JSON parsing fails, log the raw text
                    logger.warn('Failed to parse Etsy error response as JSON.', { url, status: response.status, responseText: errorText.substring(0, 500), parseError: jsonError.message }); // Log snippet
                    errorData = { error: errorText || `Status ${response.status}` }; // Use text or status as fallback
                }
            } catch (textError) {
                 // If reading text fails (unlikely but possible)
                 logger.error('Failed to read Etsy error response text.', { url, status: response.status, readError: textError.message });
                 errorData = { error: `Failed to read error response body. Status: ${response.status}` };
            }

            logger.error(`Etsy API error: ${response.status} ${response.statusText}`, {
                status: response.status,
                url,
                errorData // Log the parsed or fallback error data
            });
            // Throw an error that includes the status and potentially some text
            throw new Error(`Etsy API error: ${response.status} ${response.statusText}. Response: ${errorText.substring(0, 200)}`); // Include snippet of raw text
        }

        // If response IS ok, return it for the caller to handle .json()
        return response;
    } catch (error) {
        // Log network errors or errors thrown above
        logger.error(`etsyFetch failed for URL: ${url}`, { errorMessage: error.message, status: response?.status });

        if (retries > 0 && !error.message.includes('Authentication failed') && !error.message.includes('Rate limit exceeded')) {
            logger.warn(`Request failed, retrying in ${RETRY_DELAY * (MAX_RETRIES - retries + 1)}ms...`, { error: error.message });
            await sleep(RETRY_DELAY * (MAX_RETRIES - retries + 1)); // Exponential backoff
            return etsyFetch(url, options, retries - 1);
        }
        // Re-throw the error after logging and retries
        throw error;
    }
}

/**
 * Returns shop_id. Fetches from Etsy if needed.
 * @returns {Promise<String>} - Etsy shop ID
 */
async function getShopId() {
    if (process.env.ETSY_SHOP_ID) {
        return process.env.ETSY_SHOP_ID;
    }

    try {
        // Fetch shop ID from Etsy
        const accessToken = authService.getAccessToken();
        if (!accessToken) {
            throw new Error('No access token available');
        }
        
        const response = await etsyRequest(
            () => fetch(`${API_BASE_URL}/application/users/me`, {
                headers: {
                    'x-api-key': process.env.ETSY_API_KEY,
                    Authorization: `Bearer ${accessToken}`
                }
            }),
            { endpoint: '/users/me', method: 'GET' }
        );

        if (!response.ok) {
            logger.error('Failed to fetch shop ID', { 
                status: response.status, 
                statusText: response.statusText 
            });
            throw new Error('Failed to fetch shop ID');
        }

        const data = await response.json();
        if (!data.shop_id) {
            throw new Error('No shop found for this account');
        }

        const shop_id = data.shop_id.toString();
        dotenv.set("ETSY_SHOP_ID", shop_id);
        process.env.ETSY_SHOP_ID = shop_id;
        logger.info('Successfully fetched and saved shop ID', { shop_id });
        return shop_id;
    } catch (error) {
        logger.error('Error getting shop ID', { error: error.message });
        throw error;
    }
}

/**
 * Fetches shipping profiles from Etsy for the connected shop
 * @returns {Promise<Array>} Array of shipping profile objects
 */
async function getShippingProfiles() {
    try {
        const shopId = await getShopId();
        
        if (!shopId) {
            throw new Error('Shop ID not available');
        }
        
        const tokenData = JSON.parse(process.env.TOKEN_DATA);
        
        const response = await etsyRequest(
            () => fetch(`https://openapi.etsy.com/v3/application/shops/${shopId}/shipping-profiles`, {
                headers: {
                    'x-api-key': process.env.ETSY_API_KEY,
                    'Authorization': `Bearer ${tokenData.access_token}`
                }
            }),
            { endpoint: '/shops/:shop_id/shipping-profiles', method: 'GET', shop_id: shopId }
        );
        
        if (!response.ok) {
            throw new Error(`Failed to fetch shipping profiles: ${response.statusText}`);
        }
        
        const data = await response.json();
        return data.results;
    } catch (error) {
        logger.error('Error fetching shipping profiles:', { error: error.message });
        throw error;
    }
}

// Export necessary functions
module.exports = {
    getShopId,
    authExpired: authService.isTokenExpired, // Keep existing alias
    etsyFetch,
    API_BASE_URL,
    getShippingProfiles
};