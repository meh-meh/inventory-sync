/**
 * MongoDB Create Recommended Indexes Script
 * 
 * This script creates recommended indexes for the Etsy Inventory Management system
 * based on common query patterns and performance analysis.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { logger } = require('../utils/logger');

// Import database connection from the application
const connection = require('../config/database');

// Import models to ensure they're registered with Mongoose
const Product = require('../models/product');
const Order = require('../models/order');
const Settings = require('../models/settings');

async function createRecommendedIndexes() {
  try {
    logger.info('Starting creation of recommended MongoDB indexes...');

    // Make sure we have a connection
    if (mongoose.connection.readyState !== 1) {
      logger.info('Waiting for MongoDB connection to be established...');
      await new Promise(resolve => {
        mongoose.connection.once('connected', resolve);
        setTimeout(() => {
          if (mongoose.connection.readyState !== 1) {
            logger.error('MongoDB connection timed out');
            resolve();
          }
        }, 10000);
      });
    }

    if (mongoose.connection.readyState !== 1) {
      logger.error('MongoDB is not connected. Cannot create indexes.');
      return { status: 'error', message: 'MongoDB is not connected' };
    }

    // Define recommended indexes for each collection
    const recommendedIndexes = {
      products: [
        // Key fields used in filtering and searching
        { fields: { sku: 1 }, options: { unique: true, name: 'sku_unique' } },
        { fields: { 'etsy_data.listing_id': 1 }, options: { sparse: true, name: 'etsy_listing_id' } },
        { fields: { 'shopify_data.product_id': 1 }, options: { sparse: true, name: 'shopify_product_id' } },
        
        // Fields used in frequently used queries
        { fields: { 'quantity_on_hand': 1, 'quantity_committed': 1 }, options: { name: 'inventory_levels' } },
        { fields: { name: 'text' }, options: { name: 'name_text' } },
        
        // Fields used for sorting and dashboard
        { fields: { 'etsy_data.last_synced': -1 }, options: { sparse: true, name: 'etsy_last_synced' } },
        { fields: { 'shopify_data.last_synced': -1 }, options: { sparse: true, name: 'shopify_last_synced' } },
      ],
      
      orders: [
        // Primary identifiers
        { fields: { order_id: 1 }, options: { unique: true, name: 'order_id_unique' } },
        { fields: { receipt_id: 1 }, options: { sparse: true, name: 'receipt_id' } },
        { fields: { shopify_order_number: 1 }, options: { sparse: true, name: 'shopify_order_number' } },
        
        // Common query combinations
        { fields: { marketplace: 1, status: 1 }, options: { name: 'marketplace_status' } },
        { fields: { status: 1, 'items.is_digital': 1 }, options: { name: 'status_item_type' } },
        
        // Fields used for sorting and filtering
        { fields: { order_date: -1 }, options: { name: 'order_date_desc' } },
        { fields: { shipped_date: -1 }, options: { sparse: true, name: 'shipped_date_desc' } },
        { fields: { updatedAt: -1 }, options: { name: 'updated_at_desc' } },
        
        // Customer search
        { fields: { buyer_name: 'text' }, options: { name: 'buyer_name_text' } }
      ],
      
      settings: [
        // Already has _id as the primary key, no additional indexes needed
        { fields: { key: 1 }, options: { unique: true, name: 'key_unique' } }
      ]
    };

    // Create all recommended indexes
    const results = {};
    
    for (const [collectionName, indexes] of Object.entries(recommendedIndexes)) {
      logger.info(`Creating indexes for collection: ${collectionName}`);
      results[collectionName] = [];
      
      for (const indexDef of indexes) {
        try {
          // Get the model by name (capitalized and singular)
          const modelName = collectionName.charAt(0).toUpperCase() + 
                           collectionName.slice(1, -1); // Remove last 's'
          
          const model = mongoose.model(modelName);
          
          // Create the index
          logger.info(`Creating index ${indexDef.options.name} on ${collectionName}`);
          const result = await model.collection.createIndex(
            indexDef.fields,
            indexDef.options
          );
          
          results[collectionName].push({
            fields: indexDef.fields,
            options: indexDef.options,
            result: result
          });
          
          logger.info(`Successfully created index ${indexDef.options.name} on ${collectionName}`);
        } catch (error) {
          logger.error(`Error creating index ${indexDef.options.name} on ${collectionName}:`, {
            error: error.message
          });
          
          results[collectionName].push({
            fields: indexDef.fields,
            options: indexDef.options,
            error: error.message
          });
        }
      }
    }
    
    logger.info('Finished creating recommended indexes');
    
    return {
      status: 'success',
      timestamp: new Date(),
      results: results
    };
  } catch (error) {
    logger.error('Error creating recommended indexes:', {
      error: error.message,
      stack: error.stack
    });
    
    return {
      status: 'error',
      error: error.message,
      timestamp: new Date()
    };
  }
}

// Run the function if this script is called directly
if (require.main === module) {
  createRecommendedIndexes()
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      setTimeout(() => process.exit(0), 1000);
    })
    .catch(err => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
} else {
  // Export function if being used as a module
  module.exports = createRecommendedIndexes;
}
