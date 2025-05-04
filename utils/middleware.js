const dotenv = require("@dotenvx/dotenvx");
const authService = require('./auth-service');
const { logger } = require('./logger');

/**
 * Middleware to make flash messages available to all views
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
function setupFlashMessages(req, res, next) {
    res.locals.flashMessages = {
        success: req.flash('success'),
        error: req.flash('error')
    };
    next();
}

/**
 * Middleware to refresh authentication token if expired
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
async function refreshAuthToken(req, res, next) {
    // Skip if no token data is available yet
    if (!process.env.TOKEN_DATA) {
        return next();
    }

    // Check if token is expired
    if (authService.isTokenExpired()) {
        try {
            await authService.refreshToken();
            next();
        } catch (error) {
            logger.error('Error refreshing token:', error);
            // Continue without refreshing token, might redirect to auth later
            next();
        }
    } else {
        next();
    }
}

module.exports = {
    setupFlashMessages,
    refreshAuthToken
};