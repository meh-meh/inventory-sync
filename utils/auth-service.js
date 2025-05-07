/**
 * Authentication service for managing OAuth tokens with Etsy API
 * Handles token storage, expiration checking, and refresh operations
 * @module utils/auth-service
 */
const dotenv = require('@dotenvx/dotenvx');
const fetch = require('node-fetch');
const { logger } = require('./logger');

/**
 * Auth Service - Centralized management of authentication tokens
 *
 * This service handles all operations related to OAuth tokens:
 * - Storing tokens securely
 * - Checking token expiration
 * - Refreshing tokens
 * - Updating environment variables
 */

// Token endpoint for Etsy OAuth
const TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';

// Buffer time (5 minutes) before actual expiration to refresh token
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Save a new OAuth token from initial authentication flow
 * @param {Object} tokenData - The token response from Etsy OAuth
 * @returns {Promise<void>}
 * @throws {Error} If there's an issue saving the token data
 */
async function saveNewToken(tokenData) {
	try {
		// Save token data
		const tokenJSON = JSON.stringify(tokenData, null, 2);
		dotenv.set('TOKEN_DATA', tokenJSON, { path: '.env' });
		process.env.TOKEN_DATA = tokenJSON;

		// Calculate and save expiration time
		updateExpiresAt(tokenData.expires_in);

		logger.info('Successfully saved new auth token');
	} catch (error) {
		logger.error('Error saving token data:', error);
		throw new Error('Failed to save authentication token');
	}
}

/**
 * Update token expiration timestamp
 * Calculates and stores when the current token will expire
 * @param {number} expiresInSeconds - Token expiration in seconds
 * @returns {void}
 */
function updateExpiresAt(expiresInSeconds) {
	const now = new Date();
	const expiresAt = now.setTime(now.getTime() + expiresInSeconds * 1000);

	dotenv.set('EXPIRES_AT', expiresAt.toString(), { path: '.env' });
	process.env.EXPIRES_AT = expiresAt.toString();

	logger.debug(`Token expiration set to: ${new Date(expiresAt).toISOString()}`);
}

/**
 * Check if current token is expired or will expire soon
 * @returns {boolean} True if token is expired or will expire within buffer time
 */
function isTokenExpired() {
	if (!process.env.EXPIRES_AT) {
		logger.warn('No token expiry data found');
		return true;
	}

	const expiresAt = parseInt(process.env.EXPIRES_AT, 10);
	const now = Date.now();
	const isExpired = now + EXPIRY_BUFFER_MS > expiresAt;

	if (isExpired) {
		logger.warn('Auth token is expired or will expire soon');
	}

	return isExpired;
}

/**
 * Refresh the authentication token using the refresh token
 * Contacts Etsy API to get a new access token using the current refresh token
 * @returns {Promise<boolean>} True if refresh was successful
 * @throws {Error} If refresh token is missing or refresh request fails
 */
async function refreshToken() {
	try {
		if (!process.env.TOKEN_DATA) {
			logger.error('No token data available to refresh');
			throw new Error('No token data available');
		}

		const tokenData = JSON.parse(process.env.TOKEN_DATA);
		if (!tokenData.refresh_token) {
			logger.error('No refresh token available');
			throw new Error('No refresh token available');
		}

		const requestOptions = {
			method: 'POST',
			body: JSON.stringify({
				grant_type: 'refresh_token',
				client_id: process.env.ETSY_API_KEY,
				refresh_token: tokenData.refresh_token,
			}),
			headers: {
				'Content-Type': 'application/json',
			},
		};

		const response = await fetch(TOKEN_URL, requestOptions);

		if (!response.ok) {
			const errorData = await response.json().catch(() => response.text());
			logger.error('Failed to refresh token', {
				status: response.status,
				errorData,
			});
			throw new Error('Failed to refresh token');
		}

		const newTokenData = await response.json();

		// Save the refreshed token
		await saveNewToken(newTokenData);

		return true;
	} catch (error) {
		logger.error('Error refreshing auth token', { error: error.message });
		throw error;
	}
}

/**
 * Get the current access token for API requests
 * @returns {string|null} The current access token or null if not available
 */
function getAccessToken() {
	try {
		if (!process.env.TOKEN_DATA) {
			return null;
		}

		const tokenData = JSON.parse(process.env.TOKEN_DATA);
		return tokenData.access_token || null;
	} catch (error) {
		logger.error('Error accessing token data', { error: error.message });
		return null;
	}
}

module.exports = {
	saveNewToken,
	isTokenExpired,
	refreshToken,
	getAccessToken,
};
