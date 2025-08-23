/**
 * Etsy API helper utilities
 * Provides functions for interacting with the Etsy API v3 with built-in error handling,
 * rate limiting, authentication management, and common data retrieval operations.
 * @module utils/etsy-helpers
 */
const fetch = require('node-fetch');
const dotenv = require('@dotenvx/dotenvx');
// Correctly import only logger
const { logger } = require('./logger');
const authService = require('./auth-service');
const { sleep } = require('./shopify-helpers'); // Import sleep
const { etsyRequest } = require('./etsy-request-pool'); // Import etsyRequest

/**
 * Base URL for Etsy API v3 endpoints
 * @constant {string}
 */
const API_BASE_URL = 'https://openapi.etsy.com/v3';

/**
 * Maximum number of retry attempts for failed API requests
 * @constant {number}
 */
const MAX_RETRIES = 3;

/**
 * Base delay in milliseconds between retry attempts
 * Actual delay uses exponential backoff based on this value
 * @constant {number}
 */
const RETRY_DELAY = 1000;

// Define trackRateLimit function *before* etsyFetch
let lastRequestTime = 0;
/**
 * Delay in milliseconds between API requests to respect Etsy's rate limits
 * 100ms corresponds to max 10 requests per second
 * @constant {number}
 */
const rateLimitDelay = 100; // 100ms between requests (10 req/sec)

/**
 * Ensures requests do not exceed the Etsy rate limit (10 req/sec).
 * Adds appropriate delay between API calls to avoid rate limit errors.
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
 * Handles common error cases such as rate limiting and authentication errors.
 * Automatically refreshes expired tokens and implements exponential backoff for retries.
 *
 * @param {string} url - Full URL to fetch from Etsy API
 * @param {Object} options - Fetch options including headers and method
 * @param {number} [retries=MAX_RETRIES] - Number of retries remaining
 * @returns {Promise<Response>} - Fetch response object if successful
 * @throws {Error} If the request fails after all retry attempts or encounters an unrecoverable error
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
		if (response.status === 429) {
			// Rate limit exceeded
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
				try {
					await authService.refreshToken();
					// Update authorization header with new token
					if (options.headers && options.headers.Authorization) {
						options.headers.Authorization = `Bearer ${authService.getAccessToken()}`;
					}
					return etsyFetch(url, options, retries - 1);
				} catch (refreshError) {
					logger.error('Authentication failed - token refresh error', {
						error: refreshError.message,
						retries: retries,
					});
					throw new Error(`Authentication failed: ${refreshError.message}`);
				}
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
					logger.warn('Failed to parse Etsy error response as JSON.', {
						url,
						status: response.status,
						responseText: errorText.substring(0, 500),
						parseError: jsonError.message,
					}); // Log snippet
					errorData = { error: errorText || `Status ${response.status}` }; // Use text or status as fallback
				}
			} catch (textError) {
				// If reading text fails (unlikely but possible)
				logger.error('Failed to read Etsy error response text.', {
					url,
					status: response.status,
					readError: textError.message,
				});
				errorData = {
					error: `Failed to read error response body. Status: ${response.status}`,
				};
			}

			logger.error(`Etsy API error: ${response.status} ${response.statusText}`, {
				status: response.status,
				url,
				errorData, // Log the parsed or fallback error data
			});
			// Throw an error that includes the status and potentially some text
			throw new Error(
				`Etsy API error: ${response.status} ${response.statusText}. Response: ${errorText.substring(0, 200)}`
			); // Include snippet of raw text
		}

		// If response IS ok, return it for the caller to handle .json()
		return response;
	} catch (error) {
		// Log network errors or errors thrown above
		logger.error(`etsyFetch failed for URL: ${url}`, {
			errorMessage: error.message,
			status: response?.status,
		});

		if (
			retries > 0 &&
			!error.message.includes('Authentication failed') &&
			!error.message.includes('Rate limit exceeded')
		) {
			logger.warn(
				`Request failed, retrying in ${RETRY_DELAY * (MAX_RETRIES - retries + 1)}ms...`,
				{ error: error.message }
			);
			await sleep(RETRY_DELAY * (MAX_RETRIES - retries + 1)); // Exponential backoff
			return etsyFetch(url, options, retries - 1);
		}
		// Re-throw the error after logging and retries
		throw error;
	}
}

/**
 * Returns shop_id for the connected Etsy account
 * Uses cached value from environment variables if available, otherwise fetches from Etsy API
 * and stores for future use.
 *
 * @returns {Promise<string>} - Etsy shop ID
 * @throws {Error} If shop ID cannot be retrieved or user has no shop
 */
async function getShopId() {
	if (process.env.ETSY_SHOP_ID) {
		return process.env.ETSY_SHOP_ID;
	}

	try {
		// Fetch shop ID from Etsy
		const accessToken = authService.getAccessToken();
		if (!accessToken) {
			// Try to refresh the token before giving up
			logger.warn('No access token available, attempting to refresh token...');
			try {
				await authService.refreshToken();
				const newToken = authService.getAccessToken();
				if (!newToken) {
					throw new Error('Failed to obtain access token after refresh');
				}
				// If we got here, we have a new token
				logger.info('Successfully refreshed access token');
				return await getShopId(); // Recursive call with new token
			} catch (refreshError) {
				logger.error('Failed to refresh token:', { error: refreshError.message });
				throw new Error('No access token available');
			}
		}

		const response = await etsyRequest(
			() =>
				fetch(`${API_BASE_URL}/application/users/me`, {
					headers: {
						'x-api-key': process.env.ETSY_API_KEY,
						Authorization: `Bearer ${accessToken}`,
					},
				}),
			{ endpoint: '/users/me', method: 'GET' }
		);

		if (!response.ok) {
			// Attempt to read response body for better diagnostics (may be JSON or text)
			let bodyText = '';
			try {
				bodyText = await response.text();
			} catch (readErr) {
				logger.warn('Failed to read Etsy response body for diagnostics', {
					readErr: readErr.message,
				});
			}

			logger.error('Failed to fetch shop ID', {
				status: response.status,
				statusText: response.statusText,
				bodySnippet: bodyText ? bodyText.substring(0, 1000) : null,
			});
			throw new Error(`Failed to fetch shop ID: ${response.status} ${response.statusText}`);
		}

		const data = await response.json();
		if (!data.shop_id) {
			throw new Error('No shop found for this account');
		}

		const shop_id = data.shop_id.toString();
		dotenv.set('ETSY_SHOP_ID', shop_id);
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
 * Retrieves all available shipping profiles that can be used for product listings.
 *
 * @returns {Promise<Array>} Array of shipping profile objects containing IDs, titles, and other details
 * @throws {Error} If shipping profiles cannot be retrieved or shop is not available
 */
async function getShippingProfiles() {
	try {
		const shopId = await getShopId();

		if (!shopId) {
			throw new Error('Shop ID not available');
		}

		const tokenData = JSON.parse(process.env.TOKEN_DATA);

		const response = await etsyRequest(
			() =>
				fetch(`https://openapi.etsy.com/v3/application/shops/${shopId}/shipping-profiles`, {
					headers: {
						'x-api-key': process.env.ETSY_API_KEY,
						Authorization: `Bearer ${tokenData.access_token}`,
					},
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
	getShippingProfiles,
};

/**
 * Fetch a single Etsy listing by ID
 * @param {String} listingId
 * @returns {Promise<Object>} listing data
 */
async function getListing(listingId) {
	try {
		const accessToken = authService.getAccessToken();
		if (!accessToken) throw new Error('No Etsy access token available');

		const response = await etsyRequest(
			() =>
				fetch(`${API_BASE_URL}/application/listings/${listingId}`, {
					headers: {
						'x-api-key': process.env.ETSY_API_KEY,
						Authorization: `Bearer ${accessToken}`,
					},
				}),
			{ endpoint: '/listings/:listing_id', method: 'GET', listing_id: listingId }
		);

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(
				`Failed to fetch listing ${listingId}: ${response.status} ${response.statusText} ${text.substring(0, 200)}`
			);
		}
		const data = await response.json();
		return data;
	} catch (err) {
		logger.error('getListing error', { listingId, error: err.message });
		throw err;
	}
}

/**
 * Update an Etsy listing to set the SKU (sku field on a listing)
 * Requires Etsy write scopes for listings
 * @param {String} listingId
 * @param {String} sku
 */
async function updateListingSku(listingId, sku) {
	try {
		const accessToken = authService.getAccessToken();
		if (!accessToken) throw new Error('No Etsy access token available');

		const body = { sku };

		const shopId = await getShopId();
		const response = await etsyRequest(
			() =>
				fetch(`${API_BASE_URL}/application/shops/${shopId}/listings/${listingId}`, {
					method: 'PATCH',
					headers: {
						'x-api-key': process.env.ETSY_API_KEY,
						Authorization: `Bearer ${accessToken}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(body),
				}),
			{
				endpoint: '/shops/:shop_id/listings/:listing_id',
				method: 'PATCH',
				listing_id: listingId,
			}
		);

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(
				`Failed to update listing ${listingId}: ${response.status} ${response.statusText} ${text.substring(0, 200)}`
			);
		}

		const data = await response.json();
		logger.info('Updated listing SKU on Etsy', { listingId, sku });
		return data;
	} catch (err) {
		logger.error('updateListingSku error', { listingId, sku, error: err.message });
		throw err;
	}
}

// extend exports with new helpers
module.exports.getListing = getListing;
module.exports.updateListingSku = updateListingSku;
