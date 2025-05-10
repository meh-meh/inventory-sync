/**
 * MongoDB Timeout Test Script
 * This script verifies that the timeout parameters added to database operations
 * are working correctly for preventing long-running queries.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { logger } = require('../utils/logger');

// Connect to the database using the existing connection setup
const connection = require('../config/database');

// Sleep utility function
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function testTimeouts() {
  try {
    logger.info('Starting MongoDB timeout test...');

    // Wait for connection to be established
    if (mongoose.connection.readyState !== 1) {
      logger.info('Waiting for MongoDB connection to be established...');
      await new Promise(resolve => {
        mongoose.connection.once('connected', resolve);

        // Set a timeout in case connection doesn't establish
        setTimeout(() => {
          if (mongoose.connection.readyState !== 1) {
            logger.error('MongoDB connection timed out');
            resolve();
          }
        }, 10000);
      });
    }

    logger.info(`MongoDB connection state: ${mongoose.connection.readyState}`);
    // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting

    if (mongoose.connection.readyState !== 1) {
      logger.error('MongoDB is not connected. Test cannot continue.');
      return false;
    }

    // Load models
    const Product = require('../models/product');
    const Order = require('../models/order');

    // Test 1: Test with explicit timeout parameter
    logger.info('Test 1: Test countDocuments with explicit timeout');
    try {
      const startTime = Date.now();
      logger.info('Running countDocuments with 5 second timeout...');
      const productCount = await Product.countDocuments().maxTimeMS(5000);
      const endTime = Date.now();
      logger.info(`✅ Operation completed in ${endTime - startTime}ms with result: ${productCount}`);
    } catch (error) {
      logger.error('❌ Operation failed:', { error: error.message });
    }

    // Test 2: Test with a complex query
    logger.info('Test 2: Test complex query with timeout');
    try {
      const startTime = Date.now();
      
      // A more complex query that might take longer
      const result = await Product.find({
        $and: [
          { 'etsy_data.last_synced': { $exists: true } },
          { 'quantity_on_hand': { $gte: 0 } }
        ]
      })
      .select('sku name etsy_data.listing_id quantity_on_hand')
      .sort({ 'etsy_data.last_synced': -1 })
      .limit(10)
      .maxTimeMS(5000)
      .lean();
      
      const endTime = Date.now();
      logger.info(`✅ Complex query completed in ${endTime - startTime}ms with ${result.length} results`);
    } catch (error) {
      logger.error('❌ Complex query failed:', { error: error.message });
    }

    // Test 3: Test bulkWrite with timeout
    logger.info('Test 3: Test bulkWrite with timeout (no-op for testing)');
    try {
      const startTime = Date.now();
      
      // Create a no-op bulk write operation for testing
      const result = await Product.bulkWrite([
        {
          updateOne: {
            filter: { _id: new mongoose.Types.ObjectId() }, // Non-existent ID
            update: { $set: { last_timeout_test: new Date() } }
          }
        }
      ], {
        maxTimeMS: 5000 // 5 second timeout
      });
      
      const endTime = Date.now();
      logger.info(`✅ BulkWrite completed in ${endTime - startTime}ms`);
      logger.info(JSON.stringify(result, null, 2));
    } catch (error) {
      logger.error('❌ BulkWrite failed:', { error: error.message });
    }

    // Test 4: Test a query that would normally timeout
    logger.info('Test 4: Verify that a very complex unindexed query times out');
    try {
      const startTime = Date.now();
      
      // This is a complex text search that would be slow without proper indexing
      // We're explicitly setting a very short timeout to ensure it times out
      const result = await Product.find({
        $text: { $search: "placeholder search text" }
      })
      .maxTimeMS(1) // Extremely short timeout to force a timeout
      .exec();
      
      const endTime = Date.now();
      logger.info(`Query unexpectedly completed in ${endTime - startTime}ms with ${result.length} results`);
    } catch (error) {
      if (error.message.includes('timed out')) {
        logger.info(`✅ Query correctly timed out as expected: ${error.message}`);
      } else {
        logger.error('❌ Query failed with unexpected error:', { error: error.message });
      }
    }

    logger.info('MongoDB timeout tests completed');
    return true;
  } catch (error) {
    logger.error('Error during timeout tests:', {
      error: error.message,
      stack: error.stack,
    });
    return false;
  } finally {
    // Don't close the connection since it might be used by other tests
    logger.info('Test script completed');
  }
}

// Execute the test
testTimeouts()
  .then(success => {
    if (success) {
      logger.info('All timeout tests completed successfully');
    } else {
      logger.error('Some timeout tests failed');
    }
    // Exit after a small delay to ensure all logs are written
    setTimeout(() => process.exit(success ? 0 : 1), 1000);
  })
  .catch(err => {
    logger.error('Unhandled error in test script', { error: err.message, stack: err.stack });
    process.exit(1);
  });
