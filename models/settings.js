const mongoose = require('mongoose');
const { logger } = require('../utils/logger');

const settingSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, index: true },
    value: { type: mongoose.Schema.Types.Mixed },
    lastUpdated: { type: Date, default: Date.now }
});

// Method to get a setting value
settingSchema.statics.getSetting = async function(key) {
    try {
        const setting = await this.findOne({ key });
        return setting ? setting.value : null;
    } catch (error) {
        logger.error(`Error getting setting '${key}':`, error);
        return null;
    }
};

// Method to set or update a setting value
settingSchema.statics.setSetting = async function(key, value) {
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
