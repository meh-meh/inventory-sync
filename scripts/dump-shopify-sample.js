#!/usr/bin/env node
require('../config/database');
const Order = require('../models/order');

(async function () {
	try {
		const cursor = Order.find({
			$or: [{ marketplace: 'shopify' }, { shopify_order_number: { $exists: true } }],
		})
			.limit(5)
			.lean({ virtuals: true })
			.cursor();

		for await (const doc of cursor) {
			console.log({
				_id: doc._id,
				order_id: doc.order_id,
				marketplace: doc.marketplace,
				status: doc.status,
				items_len: Array.isArray(doc.items) ? doc.items.length : 0,
				items_is_digital_values: Array.isArray(doc.items)
					? doc.items.map(i => i.is_digital)
					: null,
				last_shopify_sync: doc.last_shopify_sync,
				shopify_order_number: doc.shopify_order_number,
			});
		}
		process.exit(0);
	} catch (err) {
		console.error('Error dumping shopify samples', err);
		process.exit(2);
	}
})();
