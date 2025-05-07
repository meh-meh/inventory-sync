/**
 * Global Etsy API request pool utility for concurrency control.
 * Ensures all Etsy API requests share a single concurrency limit.
 * Usage: await etsyRequest(() => etsyFetch(...))
 */
const { logger } = require('./logger');

const GLOBAL_CONCURRENCY_LIMIT = 5; // Tune as needed for Etsy's rate limit
let inFlight = 0;
const queue = [];

/**
 * Executes an Etsy API request with global concurrency control
 * @param {Function} fn - Function that returns a Promise for the API request
 * @param {Object} meta - Metadata about the request for logging purposes
 * @returns {Promise<any>} The result of the API request
 */
async function etsyRequest(fn, meta = {}) {
	return new Promise((resolve, reject) => {
		const run = async () => {
			inFlight++;
			const start = Date.now();
			logger.debug(`[EtsyPool] Starting request`, meta);
			try {
				const result = await fn();
				const duration = Date.now() - start;
				logger.info(`[EtsyPool] Request complete in ${duration}ms`, { ...meta, duration });
				resolve(result);
			} catch (err) {
				logger.error(`[EtsyPool] Request error`, { ...meta, error: err.message });
				reject(err);
			} finally {
				inFlight--;
				if (queue.length > 0) {
					const next = queue.shift();
					next();
				}
			}
		};
		if (inFlight < GLOBAL_CONCURRENCY_LIMIT) {
			run();
		} else {
			queue.push(run);
			logger.debug(`[EtsyPool] Queued request (queue length: ${queue.length})`, meta);
		}
	});
}

module.exports = { etsyRequest };
