/* Quick utility: dump an order by order_id for inspection
Usage: node scripts/dump-order.js shopify-6131922043106
*/

const path = require('path');
process.chdir(path.join(__dirname, '..'));
require('../config/database');
const Order = require('../models/order');

async function main() {
	const id = process.argv[2];
	if (!id) {
		console.error('Usage: node scripts/dump-order.js <order_id>');
		process.exit(1);
	}
	const order = await Order.findOne({
		$or: [{ order_id: id }, { shopify_order_number: id }],
	}).lean({ virtuals: true });
	if (!order) {
		console.error('Order not found for', id);
		process.exit(2);
	}
	console.log(JSON.stringify(order, null, 2));
	process.exit(0);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
