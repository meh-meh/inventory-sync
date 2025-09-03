const { logger } = require('./logger');

// In-memory store for sync status with enhanced retention
const syncStatus = new Map();

// Constants for sync status management
const SYNC_STATUS_RETENTION_MS = 10 * 60 * 1000; // Keep sync status for 10 minutes

/**
 * Validates and processes a syncId from request parameters
 * @param {string} requestSyncId - The sync ID from request parameters
 * @param {string} marketplace - The marketplace (etsy or shopify)
 * @param {string} syncType - The type of sync (products, orders, etc.)
 * @returns {string} A validated syncId
 */
function validateSyncId(requestSyncId, marketplace, syncType) {
	if (requestSyncId) {
		// Validate existing syncId format (allow old format for backward compatibility)
		return requestSyncId;
	}

	// Generate new standardized syncId
	return `${marketplace.toLowerCase()}-${syncType.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

/**
 * Initializes sync status tracking for a new sync operation
 * @param {string} syncId - The unique ID for this sync operation
 * @param {string} marketplace - The marketplace this sync is for (etsy or shopify)
 * @param {string} syncType - The type of sync operation (products, orders, etc.)
 * @param {Object} initialDetails - Optional object with initial status details to override defaults
 * @returns {Object} The initialized status object
 */
function initializeSyncStatus(syncId, marketplace, syncType, initialDetails = {}) {
	// Added initialDetails parameter
	const status = {
		syncId,
		marketplace,
		syncType,
		syncCount: 0,
		processedCount: 0,
		totalCount: 0,
		counts: {},
		currentPhase: `Initializing ${marketplace} ${syncType} sync`, // Default phase
		removedCount: 0,
		progress: 0, // Default progress to 0
		complete: false,
		error: null,
		startTime: Date.now(),
		lastUpdated: Date.now(),
		...initialDetails, // Spread initialDetails to override defaults like currentPhase and progress
	};

	syncStatus.set(syncId, status);
	logger.info(`Initialized sync status for ${syncId}`, { syncId, marketplace, syncType });
	return status;
}

/**
 * Updates the status of a sync operation
 * @param {string} syncId - The sync ID to update
 * @param {Object} updates - The properties to update
 * @returns {Object|null} The updated status or null if not found
 */
function updateSyncStatus(syncId, updates) {
	const status = syncStatus.get(syncId);
	if (!status) {
		logger.warn(`Attempted to update non-existent sync status: ${syncId}`);
		return null;
	}

	Object.assign(status, updates, { lastUpdated: Date.now() });
	syncStatus.set(syncId, status);
	return status;
}

/**
 * Marks a sync operation as complete
 * @param {string} syncId - The sync ID to complete
 * @param {Object} finalUpdates - Final updates to apply before marking as complete
 * @param {Error|null} error - Optional error if the sync failed
 */
function completeSyncStatus(syncId, finalUpdates = {}, error = null) {
	const status = syncStatus.get(syncId);
	if (!status) {
		logger.warn(`Attempted to complete non-existent sync status: ${syncId}`);
		return;
	}

	const updates = {
		...finalUpdates,
		complete: true,
		progress: 100,
		currentPhase: error ? 'Failed' : 'Complete',
		endTime: Date.now(),
		duration: Date.now() - status.startTime,
	};

	if (error) {
		updates.error = typeof error === 'string' ? error : error.message;
		logger.error(`Sync ${syncId} completed with error: ${updates.error}`);
	} else {
		logger.info(`Sync ${syncId} completed successfully in ${updates.duration}ms`);
	}

	Object.assign(status, updates);
	syncStatus.set(syncId, status);

	// Schedule status cleanup after retention period
	setTimeout(() => {
		if (syncStatus.has(syncId)) {
			logger.debug(`Cleaning up sync status for ${syncId} after retention period`);
			syncStatus.delete(syncId);
		}
	}, SYNC_STATUS_RETENTION_MS);
}

/**
 * Retrieves the current status of a sync operation.
 * @param {string} syncId - The sync ID to retrieve.
 * @returns {Object|undefined} The status object or undefined if not found.
 */
function getSyncStatus(syncId) {
	return syncStatus.get(syncId);
}

/**
 * Retrieves all ongoing (not complete) sync statuses.
 * Filters for statuses that have a syncType ending with '-auto'.
 * @returns {Array<Object>} An array of ongoing automatic sync status objects.
 */
function getOngoingAutoSyncs() {
	const ongoing = [];
	for (const status of syncStatus.values()) {
		if (status.syncType && status.syncType.endsWith('-auto') && !status.complete) {
			ongoing.push(status);
		}
	}
	return ongoing;
}

module.exports = {
	validateSyncId,
	initializeSyncStatus,
	updateSyncStatus,
	completeSyncStatus,
	getSyncStatus,
	getOngoingAutoSyncs,
	// Exporting the map itself is generally not recommended if direct manipulation from outside is not intended.
	// However, if other modules need to iterate over it (e.g. for the dashboard), it might be needed.
	// For now, providing specific accessor functions like getOngoingAutoSyncs is safer.
	// syncStatus, // Uncomment if direct access to the Map is truly necessary elsewhere
	SYNC_STATUS_RETENTION_MS, // Export if needed by other modules, though unlikely
};
