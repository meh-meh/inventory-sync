/**
 * Authentication routes for Etsy OAuth
 * @module routes/auth
 */
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { getShopId } = require('../utils/etsy-helpers');
const authService = require('../utils/auth-service');
const { logger } = require('../utils/logger');

const tokenUrl = 'https://api.etsy.com/v3/public/oauth/token';
const clientID = process.env.ETSY_API_KEY;
const redirectUri = 'http://localhost:3003/oauth/redirect';

/**
 * OAuth redirect handler - processes auth code and exchanges for token
 * @route GET /oauth/redirect
 * @param {Object} req - Express request object with code query parameter
 * @param {Object} res - Express response object
 */
router.get('/redirect', async (req, res) => {
	const authCode = req.query.code;
	const returnedState = req.query.state;

	// Read the PKCE verifier from the user's session if available. This ensures
	// the verifier corresponds to this specific auth attempt. Fall back to
	// the environment variable only if session storage isn't available.
	let clientVerifier = null;
	if (req && req.session && req.session.codeVerifier) {
		clientVerifier = req.session.codeVerifier;
		logger.debug('Using PKCE verifier from session for token exchange');
	} else if (process.env.CLIENT_VERIFIER) {
		clientVerifier = process.env.CLIENT_VERIFIER;
		logger.warn('PKCE verifier taken from process.env.CLIENT_VERIFIER (fallback)');
	} else {
		logger.error('No PKCE code_verifier available in session or environment');
		return res.status(400).send('Missing code_verifier for OAuth PKCE exchange');
	}

	// Verify state if we stored one in session
	if (req && req.session && req.session.oauthState) {
		if (!returnedState || returnedState !== req.session.oauthState) {
			logger.error('OAuth state mismatch', {
				returnedState,
				expected: req.session.oauthState,
			});
			return res.status(400).send('Invalid OAuth state');
		}
	}
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
			'Content-Type': 'application/json',
		},
	};

	try {
		const response = await fetch(tokenUrl, requestOptions);

		if (response.ok) {
			const tokenData = await response.json();

			// Use the auth service to save the token
			await authService.saveNewToken(tokenData);

			// Clear PKCE and state from session after successful auth
			if (req && req.session) {
				delete req.session.codeVerifier;
				delete req.session.oauthState;
				logger.debug(
					'Cleared PKCE verifier and oauth state from session after successful auth'
				);
			}

			// Redirect to the dashboard
			res.redirect('/');
		} else {
			logger.error('OAuth Error:', {
				status: response.status,
				statusText: response.statusText,
			});
			const errorData = await response.json();
			logger.error('OAuth Error details:', errorData);
			res.status(500).send('Authentication failed');
		}
	} catch (error) {
		logger.error('Error during OAuth flow:', error);
		res.status(500).send('Authentication process failed');
	}
});

/**
 * Welcome page handler after successful OAuth
 * Fetches user data to personalize the welcome page
 * @route GET /oauth/welcome
 * @param {Object} req - Express request object with access_token query parameter
 * @param {Object} res - Express response object
 */
router.get('/welcome', async (req, res) => {
	const { access_token } = req.query;
	const user_id = access_token.split('.')[0];

	try {
		const requestOptions = {
			headers: {
				'x-api-key': clientID,
				Authorization: `Bearer ${access_token}`,
			},
		};

		const response = await fetch(
			`https://api.etsy.com/v3/application/users/${user_id}`,
			requestOptions
		);

		if (response.ok) {
			const userData = await response.json();
			await getShopId();
			res.render('welcome', {
				first_name: userData.first_name,
			});
		} else {
			logger.error('API Error:', {
				status: response.status,
				statusText: response.statusText,
			});
			const errorData = await response.json();
			logger.error('API Error details:', errorData);
			res.send('Error fetching user data');
		}
	} catch (error) {
		logger.error('Error in welcome route:', error);
		res.status(500).send('Error processing welcome page');
	}
});

module.exports = router;
