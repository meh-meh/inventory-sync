/**
 * Script to wipe (delete all documents from) the main collections in the Etsy Inventory App database.
 * Usage: node test-scripts/wipe-database.js
 */

const mongoose = require('mongoose');
const path = require('path');

// Load environment variables (if using dotenv)
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const Product = require('../models/product');
const Order = require('../models/order');
const Settings = require('../models/settings');
const { logger } = require('../utils/logger');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/etsy_inventory';

async function wipeDatabase() {
  try {
    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    logger.info('Connected to MongoDB. Wiping collections...');

    const productResult = await Product.deleteMany({});
    const orderResult = await Order.deleteMany({});
    const settingsResult = await Settings.deleteMany({});

    logger.info(`Products deleted: ${productResult.deletedCount}`);
    logger.info(`Orders deleted: ${orderResult.deletedCount}`);
    logger.info(`Settings deleted: ${settingsResult.deletedCount}`);

    console.log('Database wipe complete.');
  } catch (err) {
    logger.error('Error wiping database:', err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

wipeDatabase();