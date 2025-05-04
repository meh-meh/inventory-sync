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

// Settings Dashboard
router.get('/', async (req, res) => {
    try {
        // Get connected marketplace info
        const etsyConnected = !!process.env.TOKEN_DATA;
        const shopifyConnected = !!process.env.SHOPIFY_ACCESS_TOKEN;
        
        // Get shop info if connected
        let etsyShopId = null;
        let etsyShopName = null;
        
        if (etsyConnected) {
            try {
                etsyShopId = await getShopId();
                
                // Try to get the shop name
                const tokenData = JSON.parse(process.env.TOKEN_DATA);
                const response = await fetch(`https://openapi.etsy.com/v3/application/shops/${etsyShopId}`, {
                    headers: {
                        'x-api-key': process.env.ETSY_API_KEY,
                        Authorization: `Bearer ${tokenData.access_token}`
                    }
                });
                
                if (response.ok) {
                    const shopData = await response.json();
                    etsyShopName = shopData.shop_name;

                    // Ensure api_key is encrypted in the .env file
                    dotenv.set('ETSY_API_KEY', process.env.ETSY_API_KEY, { encrypt: true });
                }
            } catch (error) {
                // Use logger instead of console.error
                logger.error('Error fetching Etsy shop details:', { error: error.message });
            }
        }
        
        // Get current settings
        const lowStockThreshold = process.env.LOW_STOCK_THRESHOLD || 5;
        const orderSyncDays = process.env.ORDER_SYNC_DAYS || 90;
        const autoSyncEnabled = process.env.AUTO_SYNC_ENABLED === 'true';
        const autoSyncInterval = process.env.AUTO_SYNC_INTERVAL || 24;
        const notificationsEnabled = process.env.NOTIFICATIONS_ENABLED === 'true';

        res.render('settings', { 
            lowStockThreshold,
            orderSyncDays,
            autoSyncEnabled,
            autoSyncInterval,
            notificationsEnabled,
            etsyShopId,
            etsyShopName,
            shopifyShopName: process.env.SHOPIFY_SHOP_NAME || null,
            etsyConnected,
            shopifyConnected
        });
    } catch (error) {
        // Use logger instead of console.error
        logger.error('Error loading settings:', { error: error.message, stack: error.stack });
        req.flash('error', 'Failed to load settings');
        res.redirect('/');
    }
});

// Save general settings - updated to handle both regular form POST and fetch API FormData
router.post('/general', upload.none(), async (req, res) => {
    try {
        // Use logger.debug or logger.info instead of console.log
        logger.debug('Received settings form data:', req.body);
        
        const {
            lowStockThreshold,
            orderSyncDays,
            autoSyncEnabled,
            autoSyncInterval,
            notificationsEnabled
        } = req.body;
        
        // Use logger.debug or logger.info instead of console.log
        logger.debug('Processing settings with values:', {
            lowStockThreshold,
            orderSyncDays,
            autoSyncEnabled,
            autoSyncInterval,
            notificationsEnabled
        });
        
        // Update environment variables
        dotenv.set('LOW_STOCK_THRESHOLD', lowStockThreshold, { encrypt: false });
        dotenv.set('ORDER_SYNC_DAYS', orderSyncDays, { encrypt: false });
        dotenv.set('AUTO_SYNC_ENABLED', autoSyncEnabled === 'on' || autoSyncEnabled === true ? 'true' : 'false', { encrypt: false });
        dotenv.set('AUTO_SYNC_INTERVAL', autoSyncInterval, { encrypt: false });
        dotenv.set('NOTIFICATIONS_ENABLED', notificationsEnabled === 'on' || notificationsEnabled === true ? 'true' : 'false', { encrypt: false });
        
        // Also update process.env so changes take effect immediately
        process.env.LOW_STOCK_THRESHOLD = lowStockThreshold;
        process.env.ORDER_SYNC_DAYS = orderSyncDays;
        process.env.AUTO_SYNC_ENABLED = autoSyncEnabled === 'on' || autoSyncEnabled === true ? 'true' : 'false';
        process.env.AUTO_SYNC_INTERVAL = autoSyncInterval;
        process.env.NOTIFICATIONS_ENABLED = notificationsEnabled === 'on' || notificationsEnabled === true ? 'true' : 'false';
        
        logger.info('Settings saved successfully', {
            LOW_STOCK_THRESHOLD: process.env.LOW_STOCK_THRESHOLD,
            ORDER_SYNC_DAYS: process.env.ORDER_SYNC_DAYS,
            AUTO_SYNC_ENABLED: process.env.AUTO_SYNC_ENABLED,
            AUTO_SYNC_INTERVAL: process.env.AUTO_SYNC_INTERVAL,
            NOTIFICATIONS_ENABLED: process.env.NOTIFICATIONS_ENABLED
        });
        
        // Check if this is an AJAX request or a regular form POST
        if (req.xhr || req.headers.accept?.includes('json')) {
            // If it's an AJAX request, return JSON
            res.json({ success: true, message: 'Settings saved successfully' });
        } else {
            // Otherwise redirect with flash message
            req.flash('success', 'Settings saved successfully');
            res.redirect('/settings');
        }
    } catch (error) {
        // Use logger instead of console.error
        logger.error('Error saving general settings:', { error: error.message, stack: error.stack });
        req.flash('error', 'Failed to save settings');
        res.redirect('/settings');
    }
});

// Prepare Etsy OAuth connection
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

// Disconnect Etsy
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
        res.redirect('/settings');
    } catch (error) {
        // Use logger instead of console.error
        logger.error('Error disconnecting Etsy:', { error: error.message, stack: error.stack });
        req.flash('error', 'Failed to disconnect from Etsy');
        res.redirect('/settings');
    }
});

// Connect Shopify
router.post('/connect-shopify', upload.none(), async (req, res) => {
    try {
        const { shopName, accessToken } = req.body;
        
        // Validate input
        if (!shopName || !accessToken) {
            req.flash('error', 'Shop name and access token are required');
            return res.redirect('/settings');
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
                return res.redirect('/settings');
            }
        } catch (apiError) {
            // Use logger.error instead of console.error
            logger.error('Shopify API connection error:', { error: apiError.message });
            
            // Handle AJAX requests differently
            if (req.xhr || req.headers.accept?.includes('json')) {
                return res.status(401).json({ 
                    success: false, 
                    message: 'Failed to connect to Shopify. Please verify your shop name and access token.' 
                });
            } else {
                req.flash('error', 'Failed to connect to Shopify. Please verify your shop name and access token.');
                return res.redirect('/settings');
            }
        }
    } catch (error) {
        // Use logger.error instead of console.error
        logger.error('Error connecting to Shopify:', { error: error.message, stack: error.stack });
        
        // Handle AJAX requests differently
        if (req.xhr || req.headers.accept?.includes('json')) {
            return res.status(500).json({ 
                success: false, 
                message: 'An error occurred while connecting to Shopify' 
            });
        } else {
            req.flash('error', 'An error occurred while connecting to Shopify');
            return res.redirect('/settings');
        }
    }
});

// Disconnect Shopify
router.post('/disconnect-shopify', async (req, res) => {
    try {
        // Clear Shopify credentials
        dotenv.set('SHOPIFY_SHOP_NAME', '');
        dotenv.set('SHOPIFY_ACCESS_TOKEN', '');
        
        // Update process.env
        process.env.SHOPIFY_SHOP_NAME = '';
        process.env.SHOPIFY_ACCESS_TOKEN = '';
        
        req.flash('success', 'Successfully disconnected from Shopify');
        res.redirect('/settings');
    } catch (error) {
        // Use logger.error instead of console.error
        logger.error('Error disconnecting Shopify:', { error: error.message, stack: error.stack });
        req.flash('error', 'Failed to disconnect from Shopify');
        res.redirect('/settings');
    }
});

// Fetch Etsy shipping profiles
router.get('/shipping-profiles', async (req, res) => {
    try {
        if (!process.env.TOKEN_DATA) {
            return res.status(401).json({ 
                success: false, 
                message: 'Not connected to Etsy' 
            });
        }
        
        const profiles = await getShippingProfiles();
        const savedProfiles = process.env.SYNC_SHIPPING_PROFILES ? 
            JSON.parse(process.env.SYNC_SHIPPING_PROFILES) : [];
        
        // Mark which profiles are selected for syncing
        // Ensure we're comparing strings to strings for proper matching
        const profilesWithSelection = profiles.map(profile => ({
            ...profile,
            selected: savedProfiles.includes(profile.shipping_profile_id.toString())
        }));
        
        res.json({ 
            success: true, 
            profiles: profilesWithSelection 
        });
    } catch (error) {
        // Use logger.error instead of console.error
        logger.error('Error fetching Etsy shipping profiles:', { error: error.message });
        res.status(500).json({ success: false, message: 'Error fetching shipping profiles' });
    }
});

// Save selected shipping profiles
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
            message: 'Shipping profiles saved successfully' 
        });
    } catch (error) {
        // Use logger.error instead of console.error
        logger.error('Error saving shipping profiles:', { error: error.message });
        res.status(500).json({ success: false, message: 'Error saving shipping profiles' });
    }
});

module.exports = router;