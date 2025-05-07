const mongoose = require('mongoose');
const { logger } = require('../utils/logger');

/**
 * Schema for application settings
 * Provides a key-value store for application configuration
 */
const settingSchema = new mongoose.Schema({
	key: { type: String, required: true, unique: true, index: true },
	value: { type: mongoose.Schema.Types.Mixed },
	lastUpdated: { type: Date, default: Date.now },
});

/**
 * Retrieve a setting value by key
 * @param {String} key - The setting key to retrieve
 * @returns {any|null} The setting value or null if not found
 */
settingSchema.statics.getSetting = async function (key) {
	try {
		const setting = await this.findOne({ key });
		return setting ? setting.value : null;
	} catch (error) {
		logger.error(`Error getting setting '${key}':`, error);
		return null;
	}
};

/**
 * Set or update a setting value
 * @param {String} key - The setting key to set
 * @param {any} value - The value to store
 * @returns {Object} The updated setting document
 * @throws {Error} If the setting could not be saved
 */
settingSchema.statics.setSetting = async function (key, value) {
	try {
		const result = await this.findOneAndUpdate(
			{ key },
			{ $set: { value, lastUpdated: new Date() } },
			{ upsert: true, new: true, setDefaultsOnInsert: true }
		);
		logger.debug(`Setting '${key}' updated successfully.`);
		return result;
	} catch (error) {
		logger.error(`Error setting setting '${key}':`, error);
		throw error; // Re-throw error to indicate failure
	}
};

const Settings = mongoose.model('Setting', settingSchema);

module.exports = Settings;
