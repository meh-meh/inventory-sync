const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { getShopId } = require('../utils/etsy-helpers');
const authService = require('../utils/auth-service');
const { logger } = require('../utils/logger');

const tokenUrl = 'https://api.etsy.com/v3/public/oauth/token';
const clientID = process.env.ETSY_API_KEY;
const clientVerifier = process.env.CLIENT_VERIFIER;
const redirectUri = 'http://localhost:3003/oauth/redirect';

router.get("/redirect", async (req, res) => {
    const authCode = req.query.code;
    const requestOptions = {
        method: 'POST',
        body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: clientID,
            redirect_uri: redirectUri,
            code: authCode,
            code_verifier: clientVerifier,
        }),
        headers: {
            'Content-Type': 'application/json'
        }
    };

    try {
        const response = await fetch(tokenUrl, requestOptions);

        if (response.ok) {
            const tokenData = await response.json();
            
            // Use the auth service to save the token
            await authService.saveNewToken(tokenData);
            
            // Redirect to the dashboard
            res.redirect('/');
        } else {
            logger.error('OAuth Error:', { status: response.status, statusText: response.statusText });
            const errorData = await response.json();
            logger.error('OAuth Error details:', errorData);
            res.status(500).send('Authentication failed');
        }
    } catch (error) {
        logger.error('Error during OAuth flow:', error);
        res.status(500).send('Authentication process failed');
    }
});

router.get("/welcome", async (req, res) => {
    const { access_token } = req.query;
    const user_id = access_token.split('.')[0];

    try {
        const requestOptions = {
            headers: {
                'x-api-key': clientID,
                Authorization: `Bearer ${access_token}`,
            }
        };

        const response = await fetch(
            `https://api.etsy.com/v3/application/users/${user_id}`,
            requestOptions
        );

        if (response.ok) {
            const userData = await response.json();
            await getShopId();
            res.render("welcome", {
                first_name: userData.first_name
            });
        } else {
            logger.error('API Error:', { status: response.status, statusText: response.statusText });
            const errorData = await response.json();
            logger.error('API Error details:', errorData);
            res.send("Error fetching user data");
        }
    } catch (error) {
        logger.error('Error in welcome route:', error);
        res.status(500).send('Error processing welcome page');
    }
});

module.exports = router;