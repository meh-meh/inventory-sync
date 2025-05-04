const mongoose = require('mongoose');
const { logger } = require('../utils/logger');

const DB_URI = process.env.MONGODB_URI || 'mongodb://localhost/etsy_inventory';

// Connect to MongoDB
mongoose.connect(DB_URI)
.then(() => {
    logger.info('Connected to MongoDB');
})
.catch(err => {
    logger.error('MongoDB connection error:', err);
    // Don't crash the application on connection failure, but log it
    console.error('MongoDB connection error:', err);
});

// Handle connection events
mongoose.connection.on('error', err => {
    logger.error('MongoDB error:', err);
});

mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected. Attempting to reconnect...');
});

mongoose.connection.on('reconnected', () => {
    logger.info('MongoDB reconnected');
});

// Graceful shutdown
process.on('SIGINT', async () => {
    try {
        await mongoose.connection.close();
        logger.info('MongoDB connection closed through app termination');
        process.exit(0);
    } catch (err) {
        logger.error('Error during MongoDB connection closure:', err);
        process.exit(1);
    }
});

module.exports = mongoose.connection;