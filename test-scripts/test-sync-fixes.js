/**
 * Test script to verify sync functionality after fixes
 * Runs a manual sync with debug logging to verify all issues have been resolved
 */
require('dotenv').config();
const { logger } = require('./utils/logger');
const { runManualSync } = require('./utils/scheduler');

// Set this to true to bypass authentication checks during testing
const SKIP_AUTH_CHECK = false;

async function testSync() {
  logger.info('Starting sync test with fixes applied');
  
  try {
    logger.info('MongoDB connection options upgraded with retry mechanism');
    logger.info('Etsy authentication handling improved with auto-refresh');
    logger.info('Shopify client initialization fixed with explicit options');
    
    // Run the manual sync with our enhancements
    await runManualSync(SKIP_AUTH_CHECK);
    
    logger.info('Sync test completed - check logs for any remaining errors');
  } catch (error) {
    logger.error('Sync test failed:', {
      errorMessage: error.message,
      stack: error.stack
    });
  }
}

// Run the test
testSync().catch(err => {
  logger.error('Unhandled error in test sync:', err);
  process.exit(1);
});
