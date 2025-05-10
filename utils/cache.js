/**
 * In-memory cache utility for the Etsy Inventory Manager
 * Provides a simple caching mechanism to reduce database load for frequently accessed data
 */

// Simple in-memory cache with TTL support
class MemoryCache {
	constructor() {
		this.cache = new Map();
		this.maxSize = 1000; // Maximum number of items to keep in cache
		this.stats = {
			hits: 0,
			misses: 0,
			sets: 0,
			evictions: 0,
		};
	}

	/**
	 * Get an item from the cache
	 * @param {string} key - The cache key
	 * @returns {any|null} The cached value or null if not found/expired
	 */
	get(key) {
		const item = this.cache.get(key);

		// If item doesn't exist or has expired
		if (!item || (item.expiry && item.expiry < Date.now())) {
			if (item) {
				// Clean up expired item
				this.cache.delete(key);
			}
			this.stats.misses++;
			return null;
		}

		// Update access time and hit count
		item.lastAccessed = Date.now();
		item.hits++;
		this.stats.hits++;

		return item.value;
	}

	/**
	 * Set an item in the cache
	 * @param {string} key - The cache key
	 * @param {any} value - The value to cache
	 * @param {number} [ttlSeconds=3600] - Time to live in seconds (default 1 hour)
	 */
	set(key, value, ttlSeconds = 3600) {
		// Clean cache if it's getting too big
		if (this.cache.size >= this.maxSize) {
			this._evictOldest();
		}

		const expiry = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;

		this.cache.set(key, {
			value,
			expiry,
			created: Date.now(),
			lastAccessed: Date.now(),
			hits: 0,
		});

		this.stats.sets++;
	}

	/**
	 * Remove an item from the cache
	 * @param {string} key - The cache key to remove
	 * @returns {boolean} True if item was removed, false if not found
	 */
	delete(key) {
		return this.cache.delete(key);
	}

	/**
	 * Clear all items from the cache
	 */
	clear() {
		this.cache.clear();
		return true;
	}

	/**
	 * Get cache statistics
	 * @returns {Object} Cache statistics
	 */
	getStats() {
		return {
			...this.stats,
			size: this.cache.size,
			maxSize: this.maxSize,
		};
	}

	/**
	 * Evict the oldest/least recently used items from the cache
	 * @private
	 */
	_evictOldest() {
		// Get all cache entries sorted by last accessed time (oldest first)
		const entries = [...this.cache.entries()].sort(
			(a, b) => a[1].lastAccessed - b[1].lastAccessed
		);

		// Remove the oldest 10% of entries
		const toRemove = Math.max(1, Math.floor(entries.length * 0.1));

		for (let i = 0; i < toRemove; i++) {
			if (entries[i]) {
				this.cache.delete(entries[i][0]);
				this.stats.evictions++;
			}
		}
	}
}

// Create a singleton instance
const cacheInstance = new MemoryCache();

module.exports = cacheInstance;
