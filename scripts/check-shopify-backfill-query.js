#!/usr/bin/env node
require('../config/database');
const Order = require('../models/order');

(async function () {
	try {
		const AUTO_SYNC_HOURS = parseInt(process.env.AUTO_SYNC_INTERVAL || '24', 10);
		const cutoff = new Date(Date.now() - AUTO_SYNC_HOURS * 60 * 60 * 1000);

		const query = {
			status: 'unshipped',
			'items.is_digital': { $ne: true },
			$and: [
				{
					$or: [
						{ marketplace: 'shopify' },
						{ shopify_order_number: { $exists: true, $ne: null } },
					],
				},
				{
					$or: [
						{ last_shopify_sync: { $lt: cutoff } },
						{ last_shopify_sync: { $exists: false } },
						{ last_shopify_sync: null },
					],
				},
			],
		};

		const count = await Order.countDocuments(query).maxTimeMS(10000);
		const sample = await Order.findOne(query).lean({ virtuals: true });

		console.log('backfill shopify query count:', count);
		console.log(
			'sample doc (null if none):',
			sample
				? {
						_id: sample._id,
						marketplace: sample.marketplace,
						status: sample.status,
						last_shopify_sync: sample.last_shopify_sync,
					}
				: null
		);
		process.exit(0);
	} catch (err) {
		console.error('Error running check:', err);
		process.exit(2);
	}
})();
