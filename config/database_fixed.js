/**
 * Database configuration module
 * Establishes and manages MongoDB connection
 * Exports the connection object for use throughout the application
 * @module config/database
 */
const mongoose = require('mongoose');
const { logger } = require('../utils/logger');

// MongoDB connection URI from environment variables or default local connection
const DB_URI = process.env.MONGODB_URI || 'mongodb://localhost/etsy_inventory';

/**
 * Establish connection to MongoDB with retry mechanism
 * Automatically retries connection upon failure with exponential backoff
 */
async function connectWithRetry() {
    const MAX_RETRIES = 5;
    const RETRY_DELAY_BASE = 1000; // Base delay in ms
    let retries = 0;
    
    while (retries < MAX_RETRIES) {
        try {
            logger.info(`Connecting to MongoDB (attempt ${retries + 1}/${MAX_RETRIES})...`);
            
            await mongoose.connect(DB_URI, {
                // Set higher timeouts to prevent operation buffering timeouts
                socketTimeoutMS: 30000, // Increase socket timeout to 30 seconds
                connectTimeoutMS: 30000, // Increase connection timeout to 30 seconds
                serverSelectionTimeoutMS: 30000, // Increase server selection timeout to 30 seconds
                maxPoolSize: 50, // Increase connection pool size for more concurrent operations
                serverApi: {
                    version: '1', // Use the latest stable API version
                    strict: true,
                    deprecationErrors: true
                }
            });
            
            logger.info('Connected to MongoDB successfully');
            return;
        } catch (err) {
            retries++;
            if (retries >= MAX_RETRIES) {
                logger.error('MongoDB connection failed after maximum retries:', err);
                // Don't crash the application on connection failure, but log it
                console.error('MongoDB connection failed after maximum retries:', err);
                break;
            }
            
            const delay = RETRY_DELAY_BASE * Math.pow(2, retries - 1);
            logger.warn(`MongoDB connection attempt failed, retrying in ${delay}ms...`, { error: err.message });
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Start connection process
connectWithRetry().catch(err => {
    logger.error('Failed to establish MongoDB connection:', err);
});

/**
 * MongoDB connection event handlers
 * Monitor connection status and log important events
 */
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

/**
 * Graceful shutdown handler
 * Properly closes the MongoDB connection when the application terminates
 */
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
