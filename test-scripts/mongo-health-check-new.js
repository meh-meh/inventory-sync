/**
 * Modified MongoDB Health Monitor
 *
 * This script performs health checks on the MongoDB database without using API strict mode,
 * which was causing the serverStatus command to fail.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { MongoClient } = require('mongodb');
const { logger } = require('../utils/logger');

// Don't import the default connection to avoid API strict mode limitations
// const connection = require('../config/database');

async function checkDatabaseHealth() {
	let client = null;

	try {
		logger.info('Starting MongoDB health check...');

		// Connect directly without API strict mode
		const uri = process.env.MONGODB_URI || 'mongodb://localhost/etsy_inventory';
		client = new MongoClient(uri, {
			useNewUrlParser: true,
			useUnifiedTopology: true,
			// Don't use serverApi parameter to avoid strict mode
		});

		await client.connect();
		logger.info('Connected to MongoDB for health check');

		const db = client.db();
		const admin = db.admin();

		// Check server status
		const serverStatus = await admin.command({ serverStatus: 1 });

		// Check build info
		const buildInfo = await admin.command({ buildInfo: 1 });

		// Create a simple report
		const report = {
			status: 'healthy',
			timestamp: new Date(),
			version: buildInfo.version,
			uptime: serverStatus.uptime,
			connections: {
				current: serverStatus.connections?.current,
				available: serverStatus.connections?.available,
			},
			operations: {
				insert: serverStatus.opcounters?.insert,
				query: serverStatus.opcounters?.query,
				update: serverStatus.opcounters?.update,
				delete: serverStatus.opcounters?.delete,
			},
		};

		// Check collections
		const collections = await db.listCollections().toArray();
		report.collections = collections.length;

		// Check for products and orders collections
		const products = await db.collection('products').countDocuments();
		const orders = await db.collection('orders').countDocuments();

		report.counts = {
			products,
			orders,
		};

		logger.info('MongoDB health check completed successfully');
		return report;
	} catch (error) {
		logger.error('Error during MongoDB health check:', {
			error: error.message,
			stack: error.stack,
		});

		return {
			status: 'error',
			error: error.message,
			timestamp: new Date(),
		};
	} finally {
		if (client) {
			try {
				await client.close();
				logger.info('MongoDB connection closed');
			} catch (err) {
				logger.error('Error closing MongoDB connection:', err);
			}
		}
	}
}

// Run the health check if this script is called directly
if (require.main === module) {
	checkDatabaseHealth()
		.then(report => {
			console.log(JSON.stringify(report, null, 2));
			setTimeout(() => process.exit(0), 1000);
		})
		.catch(err => {
			console.error('Fatal error:', err);
			process.exit(1);
		});
} else {
	// Export function if being used as a module
	module.exports = checkDatabaseHealth;
}
