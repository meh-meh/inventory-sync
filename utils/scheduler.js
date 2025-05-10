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
};
