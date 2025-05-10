/**
 * Settings routes module
 * Handles configuration settings for the application including Etsy and Shopify integrations
 * @module routes/settings
 */
const express = require('express');
const router = express.Router();
const dotenv = require('@dotenvx/dotenvx');
const crypto = require('crypto');
const { getShopId, getShippingProfiles } = require('../utils/etsy-helpers');
// Add multer for form-data parsing if using fetch with FormData
const multer = require('multer');
const upload = multer();
const shopifyHelpers = require('../utils/shopify-helpers'); // Import shopify-helpers
const { logger } = require('../utils/logger'); // Import logger
const { etsyRequest } = require('../utils/etsy-request-pool'); // Import etsyRequest
// const Settings = require('../models/settings'); // Settings model is not used directly in this file anymore
const { startOrReconfigureScheduler } = require('../utils/scheduler'); // Import scheduler function

/**
 * Safely parses a number from an environment variable string
 * @param {string|undefined} value - The value to parse
 * @param {number} defaultValue - Default value to return if parsing fails
 * @returns {number} The parsed integer or default value
 */
function safeParseInt(value, defaultValue) {
	if (value === undefined || value === null || value === 'undefined') {
		return defaultValue;
	}
	const parsed = parseInt(value, 10);
	return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Safely parses a boolean from an environment variable string
 * @param {string|undefined} value - The value to parse
 * @param {boolean} defaultValue - Default value to return if parsing fails
 * @returns {boolean} The parsed boolean or default value
 */
function safeParseBool(value, defaultValue) {
	if (value === undefined || value === null || value === 'undefined') {
		return defaultValue;
	}
	return value === 'true';
}

/**
 * Settings dashboard route
 * Displays application settings and connection status for Etsy and Shopify
 * @route GET /settings
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void} Renders the settings view with current configuration
 */
router.get('/', async (req, res) => {
	try {
		// Get connected marketplace info
		const etsyConnected = !!process.env.TOKEN_DATA;
		const shopifyConnected =
			!!process.env.SHOPIFY_ACCESS_TOKEN && !!process.env.SHOPIFY_SHOP_NAME;

		// Get shop info if connected
		let etsyShopId = null;
		let etsyShopName = null;

		if (etsyConnected) {
			try {
				etsyShopId = await getShopId(); // This might already be in process.env.ETSY_SHOP_ID

				// Try to get the shop name
				const tokenData = JSON.parse(process.env.TOKEN_DATA);
				const response = await etsyRequest(
					() =>
						fetch(`https://openapi.etsy.com/v3/application/shops/${etsyShopId}`, {
							headers: {
								'x-api-key': process.env.ETSY_API_KEY,
								Authorization: `Bearer ${tokenData.access_token}`,
							},
						}),
					{ endpoint: '/shops/:shop_id', method: 'GET', shop_id: etsyShopId }
				);

				if (response.ok) {
					const shopData = await response.json();
					etsyShopName = shopData.shop_name;
					// REMOVED: dotenv.set('ETSY_API_KEY', process.env.ETSY_API_KEY, { encrypt: true });
				}
			} catch (error) {
				logger.error('Error fetching Etsy shop details:', { error: error.message });
			}
		}

		// Get current settings with safe parsing and defaults
		const settings = {
			defaultView: process.env.DEFAULT_VIEW || 'gallery',
			lowStockThreshold: safeParseInt(process.env.LOW_STOCK_THRESHOLD, 5),
			orderSyncDays: safeParseInt(process.env.ORDER_SYNC_DAYS, 90),
			autoSyncEnabled: safeParseBool(process.env.AUTO_SYNC_ENABLED, false),
			autoSyncInterval: safeParseInt(process.env.AUTO_SYNC_INTERVAL, 24), // General setting in hours
			notificationsEnabled: safeParseBool(process.env.NOTIFICATIONS_ENABLED, false),
			// syncIntervalMinutes: safeParseInt(process.env.SYNC_INTERVAL_MINUTES, 30), // REMOVED Advanced setting in minutes
		};

		res.render('settings', {
			settings,
			etsyShopId,
			etsyShopName,
			etsyApiKey: process.env.ETSY_API_KEY,
			shopifyShopName: process.env.SHOPIFY_SHOP_NAME || null,
			shopifyApiKey: process.env.SHOPIFY_ACCESS_TOKEN,
			etsyConnected,
			shopifyConnected,
			activePage: 'settings',
		});
	} catch (error) {
		logger.error('Error loading settings:', { error: error.message, stack: error.stack });
		req.flash('error', 'Failed to load settings');
		// Render with default settings on error
		res.render('settings', {
			settings: {
				defaultView: 'gallery',
				lowStockThreshold: 5,
				orderSyncDays: 90,
				autoSyncEnabled: false,
				autoSyncInterval: 24,
				notificationsEnabled: false,
				// syncIntervalMinutes: 30, // REMOVED
			},
			activePage: 'settings',
		});
	}
});

/**
 * Save general application settings
 * Updates environment variables with user preferences
 * @route POST /settings/general
 * @param {Object} req - Express request object
 * @param {Object} req.body - Form data containing settings values
 * @param {string} req.body.defaultView - Default inventory view (gallery/list)
 * @param {string} req.body.lowStockThreshold - Threshold for low stock alerts
 * @param {string} req.body.orderSyncDays - Number of days of order history to sync
 * @param {string} req.body.autoSyncEnabled - Whether automatic sync is enabled
 * @param {string} req.body.autoSyncInterval - Hours between automatic syncs
 * @param {string} req.body.notificationsEnabled - Whether notifications are enabled
 * @param {Object} res - Express response object
 * @returns {void} Redirects back to settings page
 */
router.post('/general', async (req, res) => {
	try {
		logger.debug('Received settings form data:', req.body);

		// *** THIS IS WHERE THE VALUES NEED TO BE EXTRACTED ***
		const {
			defaultView,
			lowStockThreshold,
			orderSyncDays,
			autoSyncEnabled, // Checkbox value will be 'on' if checked, undefined if not
			autoSyncInterval,
			notificationsEnabled, // Checkbox value will be 'on' if checked, undefined if not
		} = req.body;

		// Process checkbox values: 'on' means true, undefined means false
		const autoSyncValue = autoSyncEnabled === 'on' ? 'true' : 'false';
		const notificationsValue = notificationsEnabled === 'on' ? 'true' : 'false';

		// Prepare values for saving (ensure defaults for empty strings)
		const valuesToSave = {
			DEFAULT_VIEW: defaultView || 'gallery',
			LOW_STOCK_THRESHOLD: lowStockThreshold || '5',
			ORDER_SYNC_DAYS: orderSyncDays || '90',
			AUTO_SYNC_ENABLED: autoSyncValue,
			AUTO_SYNC_INTERVAL: autoSyncInterval || '24',
			NOTIFICATIONS_ENABLED: notificationsValue,
		};

		logger.debug('Attempting to save settings:', valuesToSave);

		try {
			// Save settings concurrently using Promise.all
			await Promise.all([
				dotenv.set('DEFAULT_VIEW', valuesToSave.DEFAULT_VIEW, { encrypt: false }),
				dotenv.set('LOW_STOCK_THRESHOLD', valuesToSave.LOW_STOCK_THRESHOLD, {
					encrypt: false,
				}),
				dotenv.set('ORDER_SYNC_DAYS', valuesToSave.ORDER_SYNC_DAYS, { encrypt: false }),
				dotenv.set('AUTO_SYNC_ENABLED', valuesToSave.AUTO_SYNC_ENABLED, { encrypt: false }),
				dotenv.set('AUTO_SYNC_INTERVAL', valuesToSave.AUTO_SYNC_INTERVAL, {
					encrypt: false,
				}),
				dotenv.set('NOTIFICATIONS_ENABLED', valuesToSave.NOTIFICATIONS_ENABLED, {
					encrypt: false,
				}),
			]);
			logger.debug('dotenv.set operations completed.');

			// Update process.env in memory
			process.env.DEFAULT_VIEW = valuesToSave.DEFAULT_VIEW;
			process.env.LOW_STOCK_THRESHOLD = valuesToSave.LOW_STOCK_THRESHOLD;
			process.env.ORDER_SYNC_DAYS = valuesToSave.ORDER_SYNC_DAYS;
			process.env.AUTO_SYNC_ENABLED = valuesToSave.AUTO_SYNC_ENABLED;
			process.env.AUTO_SYNC_INTERVAL = valuesToSave.AUTO_SYNC_INTERVAL;
			process.env.NOTIFICATIONS_ENABLED = valuesToSave.NOTIFICATIONS_ENABLED;
			logger.debug('Updated process.env in memory');

			// Reconfigure the scheduler after settings change
			await startOrReconfigureScheduler();

			logger.info('General settings updated successfully.');
			req.flash('success', 'General settings saved successfully.');
		} catch (saveError) {
			logger.error('Error during dotenv.set operation:', {
				errorMessage: saveError.message,
				stack: saveError.stack,
			});
			req.flash('error', 'Failed to save one or more settings.');
		}

		res.redirect('/settings#general');
	} catch (error) {
		logger.error('Error saving general settings:', {
			error: error.message,
			stack: error.stack,
		});
		req.flash('error', 'Failed to save general settings.');
		res.redirect('/settings#general');
	}
});

/**
 * Save Etsy API credentials
 * Updates environment variables with Etsy API Key
 * @route POST /settings/etsy
 * @param {Object} req - Express request object
 * @param {Object} req.body - Form data containing settings values
 * @param {string} req.body.etsyApiKey - Etsy API Key (keystring)
 * @param {Object} res - Express response object
 * @returns {void} Redirects back to settings page
 */
router.post('/etsy', upload.none(), async (req, res) => {
	try {
		const { etsyApiKey } = req.body;

		if (!etsyApiKey) {
			req.flash('error', 'Etsy API Key is required.');
			return res.redirect('/settings#etsy');
		}

		// Validate if the key "looks" like a keystring (e.g., basic length check or pattern)
		// For Etsy, keystrings are typically alphanumeric and a certain length.
		// This is a basic check; more sophisticated validation might be needed.
		if (etsyApiKey.length < 20 || !/^[a-zA-Z0-9._-]+$/.test(etsyApiKey)) {
			// Adjusted regex to be more permissive for typical API key characters
			req.flash('error', 'Invalid Etsy API Key format.');
			return res.redirect('/settings#etsy');
		}

		await dotenv.set('ETSY_API_KEY', etsyApiKey, { encrypt: true });
		process.env.ETSY_API_KEY = etsyApiKey;

		logger.info('Etsy API Key updated successfully.');
		req.flash(
			'success',
			'Etsy API Key saved successfully. Please reconnect to Etsy if you were previously connected.'
		);
		res.redirect('/settings#etsy');
	} catch (error) {
		logger.error('Error saving Etsy API Key:', {
			error: error.message,
			stack: error.stack,
		});
		req.flash('error', 'Failed to save Etsy API Key.');
		res.redirect('/settings#etsy');
	}
});

/**
 * Save Shopify API credentials
 * Updates environment variables with Shopify Shop Name and Admin API Access Token
 * @route POST /settings/shopify
 * @param {Object} req - Express request object
 * @param {Object} req.body - Form data containing settings values
 * @param {string} req.body.shopifyShopName - Shopify Shop Name
 * @param {string} req.body.shopifyApiKey - Shopify Admin API Access Token
 * @param {Object} res - Express response object
 * @returns {void} Redirects back to settings page
 */
router.post('/shopify', upload.none(), async (req, res) => {
	try {
		const { shopifyShopName, shopifyApiKey } = req.body;

		if (!shopifyShopName || !shopifyApiKey) {
			req.flash('error', 'Shopify Shop Name and Admin API Access Token are required.');
			return res.redirect('/settings#shopify');
		}

		const cleanShopName = shopifyShopName
			.replace(/^https?:\/\//i, '')
			.replace(/\.myshopify\.com\/?$/i, '');

		// Temporarily set env vars for testing connection by shopifyHelpers
		const oldShopEnv = process.env.SHOPIFY_SHOP;
		const oldTokenEnv = process.env.SHOPIFY_ACCESS_TOKEN;
		process.env.SHOPIFY_SHOP = cleanShopName;
		process.env.SHOPIFY_ACCESS_TOKEN = shopifyApiKey;

		try {
			await shopifyHelpers.getShopInfo(); // Test connection
			logger.info('Shopify credentials validated successfully with API.');

			// Save credentials after successful validation
			await dotenv.set('SHOPIFY_SHOP_NAME', cleanShopName, { encrypt: false }); // Shop name is not typically sensitive
			await dotenv.set('SHOPIFY_ACCESS_TOKEN', shopifyApiKey, { encrypt: true });

			// Update process.env for current session
			process.env.SHOPIFY_SHOP_NAME = cleanShopName;
			// process.env.SHOPIFY_ACCESS_TOKEN is already set from the test

			logger.info('Shopify credentials updated successfully.');
			req.flash(
				'success',
				'Shopify credentials saved successfully. You may need to reconnect if you were previously connected with different credentials.'
			);
		} catch (apiError) {
			logger.error('Shopify API connection error during credential save:', {
				error: apiError.message,
			});
			// Restore old env vars if test failed
			process.env.SHOPIFY_SHOP = oldShopEnv;
			process.env.SHOPIFY_ACCESS_TOKEN = oldTokenEnv;
			req.flash(
				'error',
				'Failed to connect to Shopify with new credentials. Please verify your shop name and access token.'
			);
		} finally {
			// Ensure SHOPIFY_SHOP and SHOPIFY_ACCESS_TOKEN are correctly set to the new values if successful,
			// or restored if failed and they were defined before.
			if (
				process.env.SHOPIFY_SHOP_NAME === cleanShopName &&
				process.env.SHOPIFY_ACCESS_TOKEN === shopifyApiKey
			) {
				// If successful, ensure SHOPIFY_SHOP is also updated for helpers
				process.env.SHOPIFY_SHOP = cleanShopName;
			} else {
				// If failed, restore original values if they existed
				if (oldShopEnv !== undefined) process.env.SHOPIFY_SHOP = oldShopEnv;
				else delete process.env.SHOPIFY_SHOP;
				if (oldTokenEnv !== undefined) process.env.SHOPIFY_ACCESS_TOKEN = oldTokenEnv;
				else delete process.env.SHOPIFY_ACCESS_TOKEN;
			}
		}
		res.redirect('/settings#shopify');
	} catch (error) {
		logger.error('Error saving Shopify credentials:', {
			error: error.message,
			stack: error.stack,
		});
		req.flash('error', 'Failed to save Shopify credentials.');
		res.redirect('/settings#shopify');
	}
});

/**
 * Save Advanced application settings
 * Updates environment variables with user preferences for sync
 * @route POST /settings/advanced
 * @param {Object} req - Express request object
 * @param {Object} req.body - Form data containing settings values
 * @param {string} req.body.autoSyncEnabled - Whether automatic sync is enabled
 * @param {Object} res - Express response object
 * @returns {void} Redirects back to settings page
 */
router.post('/advanced', upload.none(), async (req, res) => {
	try {
		logger.debug('Received advanced settings form data:', req.body);

		const { autoSyncEnabled /*, syncInterval*/ } = req.body; // syncInterval removed

		const autoSyncValue = autoSyncEnabled === 'on' ? 'true' : 'false';
		// const syncIntervalValue = syncInterval || '30'; // REMOVED: Default to 30 minutes if not provided

		// REMOVED: Validate syncIntervalValue is a number and within a reasonable range (e.g., >= 5 minutes)
		// const parsedInterval = parseInt(syncIntervalValue, 10);
		// if (isNaN(parsedInterval) || parsedInterval < 5) {
		// 	req.flash('error', 'Invalid Sync Interval. Must be a number and at least 5 minutes.');
		// 	return res.redirect('/settings#advanced');
		// }

		// Note: AUTO_SYNC_ENABLED is also set in general settings.
		// This will overwrite the general AUTO_SYNC_ENABLED.
		await dotenv.set('AUTO_SYNC_ENABLED', autoSyncValue, { encrypt: false });
		// await dotenv.set('SYNC_INTERVAL_MINUTES', parsedInterval.toString(), { encrypt: false }); // REMOVED

		process.env.AUTO_SYNC_ENABLED = autoSyncValue;
		// process.env.SYNC_INTERVAL_MINUTES = parsedInterval.toString(); // REMOVED

		// Reconfigure the scheduler if relevant settings changed (e.g., if interval was here)
		// For now, AUTO_SYNC_INTERVAL is in /general, but if it moved or other relevant settings are here:
		await startOrReconfigureScheduler();

		logger.info('Advanced settings updated successfully.');
		req.flash('success', 'Advanced settings saved successfully.');
		res.redirect('/settings#advanced');
	} catch (error) {
		logger.error('Error saving advanced settings:', {
			error: error.message,
			stack: error.stack,
		});
		req.flash('error', 'Failed to save advanced settings.');
		res.redirect('/settings#advanced');
	}
});

/**
 * Initiates Etsy OAuth connection process
 * Generates code verifier and redirects to Etsy authorization page
 * @route GET /settings/connect-etsy
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void} Redirects to Etsy OAuth endpoint
 */
router.get('/connect-etsy', (req, res) => {
	const clientID = process.env.ETSY_API_KEY;
	const redirectURI = 'http://localhost:3003/oauth/redirect';

	// Generate a code verifier (random string)
	const codeVerifier = crypto.randomBytes(32).toString('hex');

	// Generate a code challenge (SHA256 hash of the code verifier)
	const codeChallenge = crypto
		.createHash('sha256')
		.update(codeVerifier)
		.digest('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=/g, '');

	// Save the code verifier for later use
	dotenv.set('CLIENT_VERIFIER', codeVerifier);
	process.env.CLIENT_VERIFIER = codeVerifier;

	// Redirect to Etsy OAuth
	const scopes = 'transactions_r transactions_w listings_r listings_w';
	const authUrl = `https://www.etsy.com/oauth/connect?response_type=code&client_id=${clientID}&redirect_uri=${redirectURI}&scope=${encodeURIComponent(scopes)}&state=superstate&code_challenge=${codeChallenge}&code_challenge_method=S256`;

	res.redirect(authUrl);
});

/**
 * Disconnects the application from Etsy
 * Clears Etsy authentication tokens and shop ID
 * @route POST /settings/disconnect-etsy
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void} Redirects back to settings page
 */
router.post('/disconnect-etsy', async (req, res) => {
	try {
		// Clear Etsy tokens
		dotenv.set('TOKEN_DATA', '');
		dotenv.set('EXPIRES_AT', '');
		dotenv.set('ETSY_SHOP_ID', '');

		// Update process.env
		process.env.TOKEN_DATA = '';
		process.env.EXPIRES_AT = '';
		process.env.ETSY_SHOP_ID = '';

		req.flash('success', 'Successfully disconnected from Etsy');
		res.redirect('/settings#etsy');
	} catch (error) {
		// Use logger instead of console.error
		logger.error('Error disconnecting Etsy:', { error: error.message, stack: error.stack });
		req.flash('error', 'Failed to disconnect from Etsy');
		res.redirect('/settings#etsy');
	}
});

/**
 * Connects the application to Shopify
 * Validates and stores Shopify credentials
 * @route POST /settings/connect-shopify
 * @param {Object} req - Express request object
 * @param {Object} req.body - Form data containing Shopify credentials
 * @param {string} req.body.shopName - Shopify shop name
 * @param {string} req.body.accessToken - Shopify access token
 * @param {Object} res - Express response object
 * @returns {void|Object} Redirects to settings page or returns JSON response for AJAX requests
 */
router.post('/connect-shopify', upload.none(), async (req, res) => {
	try {
		const { shopName, accessToken } = req.body;

		// Validate input
		if (!shopName || !accessToken) {
			req.flash('error', 'Shop name and access token are required');
			// Ensure redirect goes to the Shopify tab
			return res.redirect('/settings#shopify');
		}

		// Clean shop name - remove https:// and .myshopify.com if present
		const cleanShopName = shopName
			.replace(/^https?:\/\//i, '')
			.replace(/\.myshopify\.com\/?$/i, '');

		// Test the connection with Shopify API
		try {
			// Set temporary environment variables for shopify-helpers to use
			process.env.SHOPIFY_SHOP = cleanShopName;
			process.env.SHOPIFY_ACCESS_TOKEN = accessToken;

			// Use the shopify-helpers module to test the connection
			// Try to fetch shop info to verify credentials
			const shopInfo = await shopifyHelpers.getShopInfo();
			// Use logger.info instead of console.log
			logger.info('Successfully connected to Shopify shop:', { shopName: shopInfo.name });

			// Save Shopify credentials only after successful verification
			dotenv.set('SHOPIFY_SHOP_NAME', cleanShopName);
			dotenv.set('SHOPIFY_ACCESS_TOKEN', accessToken);

			// Update process.env - using SHOPIFY_SHOP_NAME for consistency with the rest of the codebase
			process.env.SHOPIFY_SHOP_NAME = cleanShopName;

			req.flash('success', `Successfully connected to Shopify shop: ${shopInfo.name}`);

			// Handle AJAX requests differently from regular form submissions
			if (req.xhr || req.headers.accept?.includes('json')) {
				return res.json({ success: true, shopName: shopInfo.name });
			} else {
				// Ensure redirect goes to the Shopify tab
				return res.redirect('/settings#shopify');
			}
		} catch (apiError) {
			// Use logger.error instead of console.error
			logger.error('Shopify API connection error:', { error: apiError.message });

			// Handle AJAX requests differently
			if (req.xhr || req.headers.accept?.includes('json')) {
				return res.status(401).json({
					success: false,
					message:
						'Failed to connect to Shopify. Please verify your shop name and access token.',
				});
			} else {
				req.flash(
					'error',
					'Failed to connect to Shopify. Please verify your shop name and access token.'
				);
				// Ensure redirect goes to the Shopify tab
				return res.redirect('/settings#shopify');
			}
		}
	} catch (error) {
		// Use logger.error instead of console.error
		logger.error('Error connecting to Shopify:', { error: error.message, stack: error.stack });

		// Handle AJAX requests differently
		if (req.xhr || req.headers.accept?.includes('json')) {
			return res.status(500).json({
				success: false,
				message: 'An error occurred while connecting to Shopify',
			});
		} else {
			req.flash('error', 'An error occurred while connecting to Shopify');
			// Ensure redirect goes to the Shopify tab
			return res.redirect('/settings#shopify');
		}
	}
});

/**
 * Disconnects the application from Shopify
 * Clears Shopify credentials
 * @route POST /settings/disconnect-shopify
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {void} Redirects back to settings page
 */
router.post('/disconnect-shopify', async (req, res) => {
	try {
		// Clear Shopify credentials
		dotenv.set('SHOPIFY_SHOP_NAME', '');
		dotenv.set('SHOPIFY_ACCESS_TOKEN', '');

		// Update process.env
		process.env.SHOPIFY_SHOP_NAME = '';
		process.env.SHOPIFY_ACCESS_TOKEN = '';

		req.flash('success', 'Successfully disconnected from Shopify');
		// Ensure redirect goes to the Shopify tab
		res.redirect('/settings#shopify');
	} catch (error) {
		// Use logger.error instead of console.error
		logger.error('Error disconnecting Shopify:', { error: error.message, stack: error.stack });
		req.flash('error', 'Failed to disconnect from Shopify');
		// Ensure redirect goes to the Shopify tab
		res.redirect('/settings#shopify');
	}
});

/**
 * Fetches Etsy shipping profiles
 * Retrieves available shipping profiles from Etsy and marks selected ones
 * @route GET /settings/shipping-profiles
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Object} JSON response containing shipping profiles
 */
router.get('/shipping-profiles', async (req, res) => {
	try {
		if (!process.env.TOKEN_DATA) {
			return res.status(401).json({
				success: false,
				message: 'Not connected to Etsy',
			});
		}

		const profiles = await getShippingProfiles();
		const savedProfiles = process.env.SYNC_SHIPPING_PROFILES
			? JSON.parse(process.env.SYNC_SHIPPING_PROFILES)
			: [];

		// Mark which profiles are selected for syncing
		// Ensure we're comparing strings to strings for proper matching
		const profilesWithSelection = profiles.map(profile => ({
			...profile,
			selected: savedProfiles.includes(profile.shipping_profile_id.toString()),
		}));

		res.json({
			success: true,
			profiles: profilesWithSelection,
		});
	} catch (error) {
		// Use logger.error instead of console.error
		logger.error('Error fetching Etsy shipping profiles:', { error: error.message });
		res.status(500).json({ success: false, message: 'Error fetching shipping profiles' });
	}
});

/**
 * Saves selected Etsy shipping profiles for synchronization
 * Updates environment variables with selected profile IDs
 * @route POST /settings/shipping-profiles
 * @param {Object} req - Express request object
 * @param {Object} req.body - Request body containing selected profiles
 * @param {Array|string} req.body.selectedProfiles - Array of profile IDs or JSON string
 * @param {Object} res - Express response object
 * @returns {Object} JSON response indicating success or failure
 */
router.post('/shipping-profiles', async (req, res) => {
	try {
		const { selectedProfiles } = req.body;

		// Parse the profiles if it's a string
		let profileIds = selectedProfiles;
		if (typeof selectedProfiles === 'string') {
			profileIds = JSON.parse(selectedProfiles);
		}

		// Save to environment variables
		dotenv.set('SYNC_SHIPPING_PROFILES', JSON.stringify(profileIds), { encrypt: false });
		process.env.SYNC_SHIPPING_PROFILES = JSON.stringify(profileIds);

		res.json({
			success: true,
			message: 'Shipping profiles saved successfully',
		});
	} catch (error) {
		// Use logger.error instead of console.error
		logger.error('Error saving shipping profiles:', { error: error.message });
		res.status(500).json({ success: false, message: 'Error saving shipping profiles' });
	}
});

module.exports = router;
