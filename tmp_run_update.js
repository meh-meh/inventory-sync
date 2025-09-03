// One-off runner to call updateListingSku with dotenvx loaded so encrypted env vars are available
require('@dotenvx/dotenvx').config();
const { updateListingSku } = require('./utils/etsy-helpers');

(async function () {
	try {
		console.log('Starting updateListingSku for 4303887099 -> ope');
		const res = await updateListingSku('4303887099', 'ope');
		console.log('UPDATE SUCCESS:', JSON.stringify(res).substring(0, 200));
		process.exit(0);
	} catch (err) {
		console.error('UPDATE FAILED:', err && err.message ? err.message : err);
		console.error(err && err.stack ? err.stack : 'no stack');
		process.exit(2);
	}
})();
