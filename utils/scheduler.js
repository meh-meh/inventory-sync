const cron = require('node-cron');
const { logger } = require('./logger');
// Import performFullSync from routes/sync.js
const { performFullSync } = require('../routes/sync');
// Import auth service for token verification
const authService = require('./auth-service');

let scheduledTask = null;

/**
 * Starts or reconfigures the synchronization scheduler based on current settings.
 */
async function startOrReconfigureScheduler() {
	if (scheduledTask) {
		scheduledTask.stop();
		logger.info('Stopped existing scheduled sync task.');
		scheduledTask = null;
	}

	const autoSyncEnabled = process.env.AUTO_SYNC_ENABLED === 'true';
	const autoSyncIntervalHours = parseInt(process.env.AUTO_SYNC_INTERVAL, 10);

	if (autoSyncEnabled && autoSyncIntervalHours > 0) {
		// Cron expression for "at minute 0 past every X hour"
		// e.g., if autoSyncIntervalHours is 6, this runs at 00:00, 06:00, 12:00, 18:00
		const cronExpression = `0 */${autoSyncIntervalHours} * * *`;

		scheduledTask = cron.schedule(
			cronExpression,
			async () => {
				logger.info(
					`Starting scheduled synchronization (interval: ${autoSyncIntervalHours} hours)...`
				);
				try {
					// Verify authentication before running sync
					const isAuthenticated = await verifyAuthentication();

					if (!isAuthenticated) {
						logger.warn('Skipping scheduled sync due to authentication issues');
						return;
					}

					if (typeof performFullSync === 'function') {
						await performFullSync(); // Assuming performFullSync handles its own logging for success/failure
						logger.info('Scheduled synchronization completed successfully.');
					} else {
						logger.error(
							'performFullSync function is not available. Auto-sync cannot run.'
						);
					}
				} catch (error) {
					logger.error('Error during scheduled synchronization:', {
						errorMessage: error.message,
						stack: error.stack,
					});
				}
			},
			{
				scheduled: true,
				timezone: 'Etc/UTC', // Or your preferred timezone
			}
		);

		logger.info(
			`Synchronization scheduler started. Will run every ${autoSyncIntervalHours} hours. Cron: ${cronExpression}`
		);
	} else {
		logger.info(
			'Automatic synchronization is disabled or interval is invalid. Scheduler not started.'
		);
	}
}

/**
 * Verifies authentication before running the scheduled sync.
 * Attempts to refresh the token if it's expired.
 * @returns {Promise<boolean>} True if authentication is valid, false otherwise
 */
async function verifyAuthentication() {
	try {
		// Check if token is expired
		if (authService.isTokenExpired()) {
			logger.info(
				'Authentication token is expired, attempting to refresh before scheduled sync'
			);
			await authService.refreshToken();
			logger.info('Successfully refreshed authentication token for scheduled sync');
		}
		return true;
	} catch (error) {
		logger.error('Authentication verification failed before scheduled sync', {
			error: error.message,
			stack: error.stack,
		});
		return false;
	}
}

/**
 * Runs a manual sync for testing purposes.
 * @param {boolean} [skipAuthCheck=false] - Whether to skip authentication checks
 * @returns {Promise<void>} A promise that resolves when the sync completes.
 */
async function runManualSync(skipAuthCheck = false) {
	logger.info('Starting manual synchronization...');
	try {
		let isAuthenticated = true;

		// Skip authentication check if requested
		if (!skipAuthCheck) {
			isAuthenticated = await verifyAuthentication();
		} else {
			logger.info('Skipping authentication check as requested');
		}

		if (!isAuthenticated) {
			logger.warn('Skipping manual sync due to authentication issues');
			return;
		}

		if (typeof performFullSync === 'function') {
			await performFullSync();
			logger.info('Manual synchronization completed successfully.');
		} else {
			logger.error('performFullSync function is not available. Manual sync cannot run.');
		}
	} catch (error) {
		logger.error('Error during manual synchronization:', {
			errorMessage: error.message,
			stack: error.stack,
		});
	}
}

/**
 * Runs an automatic sync on server startup if AUTO_SYNC_ENABLED is true
 * and the last sync was outside of the configured interval.
 * @returns {Promise<void>} A promise that resolves when the startup sync completes or is skipped.
 */
async function runStartupSync() {
	const autoSyncEnabled = process.env.AUTO_SYNC_ENABLED === 'true';

	if (!autoSyncEnabled) {
		logger.info('AUTO_SYNC_ENABLED is not set to true. Skipping initial sync on startup.');
		return;
	}

	// Get the auto sync interval (in hours)
	const autoSyncIntervalHours = parseInt(process.env.AUTO_SYNC_INTERVAL, 10) || 24; // Default to 24 hours if not set

	try {
		// Import Settings model for checking last sync times
		const Settings = require('../models/settings');

		// Get the most recent sync time from any of the sync types
		const syncTimes = await Promise.all([
			Settings.getSetting('lastEtsyProductSync'),
			Settings.getSetting('lastShopifyProductSync'),
			Settings.getSetting('lastEtsyOrderSync'),
			Settings.getSetting('lastShopifyOrderSync'),
		]);

		// Filter out null values and convert to Date objects
		const validSyncTimes = syncTimes.filter(time => time).map(time => new Date(time).getTime());

		// Get the most recent sync time (if any)
		const mostRecentSyncTime = validSyncTimes.length ? Math.max(...validSyncTimes) : null;

		// If there's a recent sync, check if it's outside the interval
		if (mostRecentSyncTime) {
			// Calculate how many milliseconds ago the last sync occurred
			const timeSinceLastSync = Date.now() - mostRecentSyncTime;
			// Convert auto sync interval to milliseconds
			const intervalMs = autoSyncIntervalHours * 60 * 60 * 1000;

			// If the last sync was within the interval, skip the sync
			if (timeSinceLastSync < intervalMs) {
				logger.info(
					`Last sync was ${Math.round(timeSinceLastSync / (60 * 1000))} minutes ago, ` +
						`which is within the configured interval of ${autoSyncIntervalHours} hours. Skipping initial sync.`
				);
				return;
			}

			logger.info(
				`Last sync was ${Math.round(timeSinceLastSync / (60 * 60 * 1000))} hours ago. ` +
					`Performing initial sync as it exceeds the configured interval of ${autoSyncIntervalHours} hours.`
			);
		} else {
			logger.info('No previous sync found. Running initial sync on server startup.');
		}

		// Run the sync
		await runManualSync();
		logger.info('Initial startup sync completed successfully.');
	} catch (error) {
		logger.error('Error during initial startup sync:', {
			errorMessage: error.message,
			stack: error.stack,
		});
	}
}

/**
 * Stops the synchronization scheduler.
 */
function stopScheduler() {
	if (scheduledTask) {
		scheduledTask.stop();
		logger.info('Synchronization scheduler stopped.');
		scheduledTask = null;
	}
}

module.exports = {
	startOrReconfigureScheduler,
	stopScheduler,
	runManualSync,
	runStartupSync,
};
