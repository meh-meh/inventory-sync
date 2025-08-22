#!/usr/bin/env node
require('../config/database');
const Order = require('../models/order');

(async function () {
	try {
		const a = await Order.countDocuments({ marketplace: 'shopify' }).maxTimeMS(10000);
		const b = await Order.countDocuments({ shopify_order_number: { $exists: true } }).maxTimeMS(
			10000
		);
		const c = await Order.countDocuments({
			$or: [{ marketplace: 'shopify' }, { shopify_order_number: { $exists: true } }],
		}).maxTimeMS(10000);
		console.log('marketplace_shopify:', a);
		console.log('shopify_order_number_exists:', b);
		console.log('either:', c);
		process.exit(0);
	} catch (err) {
		console.error('Error running check:', err);
		process.exit(2);
	}
})();
