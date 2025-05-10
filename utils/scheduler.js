const cron = require('node-cron');
const { logger } = require('./logger');
// Assume performFullSync will be available from routes/sync.js or a dedicated sync service
// For now, let's try to require it from routes/sync.js, assuming it exports such a function.
// This might need adjustment based on the actual structure of routes/sync.js.
const { performFullSync } = require('../routes/sync'); // Placeholder - adjust if necessary

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
};
