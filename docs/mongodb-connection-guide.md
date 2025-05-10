<!-- filepath: c:\Users\Mat\Documents\Etsy_Inventory\docs\mongodb-connection-guide.md -->
# MongoDB Connection Troubleshooting Guide

This guide provides solutions for common MongoDB connection issues in the Etsy Inventory Management application.

## Recent Issues Fixed

We identified and resolved the following issues:

1. **MongoDB Connection Timeouts** - The database operations were timing out with errors like:

   ```plaintext
   Operation `products.countDocuments()` buffering timed out after 10000ms
   ```

2. **Authentication Issues** - Etsy API authentication was failing with:

   ```plaintext
   No access token available
   ```

## Solutions Implemented

### 1. Enhanced MongoDB Connection Configuration

We updated the database connection configuration with:

- Increased buffer timeouts from 10s to 60s
- Added connection retry mechanism with exponential backoff
- Improved connection monitoring and auto-reconnection
- Added heartbeat checks to keep the connection alive

```javascript
// Set Mongoose options at the global level
mongoose.set('bufferTimeoutMS', 60000); // Increase buffer timeout to 60 seconds
```

### 2. MongoDB Connection Options

Optimized MongoDB connection parameters:

```javascript
await mongoose.connect(DB_URI, {
    socketTimeoutMS: 60000,        // Increased from 30s to 60s
    connectTimeoutMS: 60000,       // Increased from 30s to 60s
    serverSelectionTimeoutMS: 60000, // Increased from 30s to 60s
    maxPoolSize: 50,               // Large pool for concurrent operations
    bufferCommands: true,          // Buffer commands when connection is lost
    autoIndex: true,               // Build indexes
    heartbeatFrequencyMS: 10000,   // Check server status every 10 seconds    serverApi: {
        version: '1',
        strict: false,       // Disabled strict mode to allow admin commands
        deprecationErrors: true
    }
});
```

### 3. Database Operation Timeouts

Added explicit timeouts to all database operations to prevent them from hanging indefinitely:

```javascript
// For query operations
const products = await Product.find(filter)
    .maxTimeMS(15000)  // 15-second timeout
    .lean();

// For write operations
const result = await Product.bulkWrite(bulkOps, { 
    ordered: false,
    maxTimeMS: 60000   // 60-second timeout
});
```

### 4. Application-Level Caching

Implemented in-memory caching for frequently accessed data using `cache.js` utility:

```javascript
// Cache the dashboard data for 5 minutes
const cache = require('./utils/cache');
const CACHE_KEY = 'dashboard_data';
const CACHE_TTL = 300; // 5 minutes

// Try to get from cache first
const cachedData = cache.get(CACHE_KEY);
if (cachedData) {
    return cachedData;
}

// Cache miss, fetch and store
const data = await fetchFreshData();
cache.set(CACHE_KEY, data, CACHE_TTL);
```

## Diagnostic Tools

We've created several diagnostic and maintenance scripts to help monitor and optimize MongoDB:

1. **Test MongoDB Connection**:

   ```bash
   npm run test-mongodb
   ```

   Verifies basic database connectivity and performs CRUD operations.

2. **Test Timeout Parameters**:

   ```bash
   npm run test-timeouts
   ```

   Validates that our timeout parameters are working correctly.

3. **MongoDB Health Check**:

   ```bash
   npm run check-db
   ```

   Comprehensive health check that reports on database status, performance metrics, and potential issues.

4. **Index Analysis**:

   ```bash
   npm run analyze-indexes
   ```

   Analyzes existing indexes and provides recommendations for missing or inefficient indexes.

5. **Create Recommended Indexes**:

   ```bash
   npm run create-indexes
   ```

   Sets up optimal indexes for all collections based on common query patterns.

## Best Practices

### MongoDB Operations

1. **Always use timeouts**: Add `maxTimeMS()` to all database operations to prevent indefinite waiting.

   ```javascript
   await Product.countDocuments(filter).maxTimeMS(10000);
   ```

2. **Use lean queries**: For read-only operations, use `.lean()` to improve performance.

   ```javascript
   const products = await Product.find().lean();
   ```

3. **Paginate results**: Always limit results when possible to avoid large result sets.

   ```javascript
   const products = await Product.find()
       .skip(offset)
       .limit(pageSize)
       .maxTimeMS(10000);
   ```

4. **Use caching**: Cache frequently accessed, rarely changing data.

### MongoDB Maintenance

1. **Regular backups**: Ensure regular backups of your database.

2. **Monitor database size**: Use the health check script to monitor database growth.

3. **Index optimization**: Periodically review and optimize indexes.

4. **Run the diagnostic tools**: Run health check weekly to detect issues before they become critical.

## Troubleshooting Steps

If you encounter MongoDB connection issues:

1. **Check if MongoDB is running**:

   ```powershell
   Get-Service -Name MongoDB
   ```

2. **Restart MongoDB service**:

   ```powershell
   Restart-Service -Name MongoDB
   ```

3. **Run the connection test**:

   ```bash
   npm run test-mongodb
   ```

4. **Check application logs**:
   Review `combined.log` and `error.log` for MongoDB-related errors.

5. **Run the health check**:

   ```bash
   npm run check-db
   ```

6. **Check for slow queries**:
   Look for operations timing out in the logs and optimize them.
