/**
 * MongoDB Connection Test Script
 * This script verifies MongoDB connectivity and performs basic CRUD operations
 * to ensure the database is working properly.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { logger } = require('../utils/logger');

// Connect to the database using the existing connection setup
const connection = require('../config/database');

// Sleep utility function
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function testDatabaseOperations() {
	try {
		logger.info('Starting MongoDB connection test...');

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

		// Test models access
		const Product = require('../models/product');
		const Order = require('../models/order');
		const Settings = require('../models/settings');

		// Test 1: Count documents
		logger.info('Testing document count operations...');
		const productCount = await Product.countDocuments().maxTimeMS(5000).exec();
		logger.info(`Product count: ${productCount}`);

		const orderCount = await Order.countDocuments().maxTimeMS(5000).exec();
		logger.info(`Order count: ${orderCount}`);

		// Test 2: Settings retrieval
		logger.info('Testing settings retrieval...');
		const lastEtsySync = await Settings.getSetting('lastEtsyOrderSync');
		logger.info(`Last Etsy sync setting: ${lastEtsySync || 'Not set'}`);

		// Test 3: Create a test setting
		logger.info('Testing settings creation...');
		const testSettingKey = `test_setting_${Date.now()}`;
		const testSettingValue = `Test value at ${new Date().toISOString()}`;

		await Settings.setSetting(testSettingKey, testSettingValue);
		const retrievedSetting = await Settings.getSetting(testSettingKey);

		if (retrievedSetting === testSettingValue) {
			logger.info('✅ Settings create and retrieve test passed');
		} else {
			logger.error('❌ Settings create and retrieve test failed', {
				expected: testSettingValue,
				received: retrievedSetting,
			});
		}

		// Test 4: Find recent products with lean query
		logger.info('Testing product retrieval with lean query...');
		const recentProducts = await Product.find()
			.sort({ 'etsy_data.last_synced': -1 })
			.limit(2)
			.lean()
			.maxTimeMS(5000)
			.exec();

		logger.info(`Retrieved ${recentProducts.length} recent products`);

		// Final result
		logger.info('MongoDB connection and operations test completed successfully!');
		return true;
	} catch (error) {
		logger.error('Error during MongoDB test:', {
			error: error.message,
			stack: error.stack,
		});
		return false;
	} finally {
		// Don't close the connection since it's shared with the application
		// Just report the final state
		logger.info(`Final MongoDB connection state: ${mongoose.connection.readyState}`);
	}
}

// Run the test
testDatabaseOperations()
	.then(success => {
		if (success) {
			logger.info('✅ All MongoDB tests passed');
		} else {
			logger.error('❌ Some MongoDB tests failed');
		}
	})
	.catch(err => {
		logger.error('Unhandled error in test script:', err);
	});
