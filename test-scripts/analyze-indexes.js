/**
 * MongoDB Index Analysis Script
 * 
 * This script analyzes your MongoDB collections and identifies:
 * 1. Existing indexes and their size/usage
 * 2. Missing indexes based on common query patterns
 * 3. Recommendations for index creation or optimization
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { MongoClient } = require('mongodb');
const { logger } = require('../utils/logger');

// Import database connection from the application
const connection = require('../config/database');

async function analyzeIndexes() {
  try {
    logger.info('Starting MongoDB index analysis...');

    // Make sure we have a connection
    if (mongoose.connection.readyState !== 1) {
      logger.info('Waiting for MongoDB connection to be established...');
      await new Promise(resolve => {
        mongoose.connection.once('connected', resolve);
        setTimeout(() => {
          if (mongoose.connection.readyState !== 1) {
            logger.error('MongoDB connection timed out');
            resolve();
          }
        }, 10000);
      });
    }

    if (mongoose.connection.readyState !== 1) {
      logger.error('MongoDB is not connected. Analysis cannot continue.');
      return { status: 'error', message: 'MongoDB is not connected' };
    }

    const mongoClient = mongoose.connection.getClient();
    const db = mongoClient.db();
    
    // Get list of collections in the database
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    logger.info(`Found ${collectionNames.length} collections in the database`);
    
    // Analyze indexes for each collection
    const indexAnalysis = {};
    
    for (const collectionName of collectionNames) {
      logger.info(`Analyzing indexes for collection: ${collectionName}`);
      
      const collection = db.collection(collectionName);
      
      // Get existing indexes
      const indexes = await collection.indexes();
      
      // Get collection stats including index details
      const stats = await collection.stats();
      
      // Calculate index overhead (ratio of index size to data size)
      const totalIndexSize = stats.totalIndexSize || 0;
      const dataSize = stats.size || 1; // Avoid division by zero
      const indexOverhead = totalIndexSize / dataSize;
      
      // Analyze each index
      const indexDetails = indexes.map(index => {
        const indexName = index.name;
        const indexKeys = JSON.stringify(index.key);
        const isUnique = index.unique || false;
        const isSparse = index.sparse || false;
        
        // Get size of this specific index
        const indexSize = stats.indexSizes?.[indexName] || 0;
        
        return {
          name: indexName,
          keys: indexKeys,
          unique: isUnique,
          sparse: isSparse,
          size: indexSize,
          sizeInMB: indexSize / (1024 * 1024),
        };
      });
      
      // Create summary for this collection
      indexAnalysis[collectionName] = {
        documentCount: stats.count || 0,
        dataSize: dataSize,
        dataSizeInMB: dataSize / (1024 * 1024),
        totalIndexSize: totalIndexSize,
        totalIndexSizeInMB: totalIndexSize / (1024 * 1024),
        indexOverhead: indexOverhead.toFixed(2),
        indexCount: indexes.length,
        indexes: indexDetails
      };
    }
    
    // Analyze query patterns for common collections
    const queryPatternAnalysis = await analyzeQueryPatterns(db);
    
    // Generate recommendations
    const recommendations = generateRecommendations(indexAnalysis, queryPatternAnalysis);
    
    // Complete the report
    const report = {
      timestamp: new Date(),
      status: 'success',
      databaseName: mongoose.connection.name,
      collectionCount: collectionNames.length,
      indexAnalysis: indexAnalysis,
      queryPatternAnalysis: queryPatternAnalysis,
      recommendations: recommendations
    };
    
    logger.info('MongoDB index analysis completed successfully');
    return report;
  } catch (error) {
    logger.error('Error during MongoDB index analysis:', {
      error: error.message,
      stack: error.stack
    });
    
    return {
      status: 'error',
      error: error.message,
      timestamp: new Date()
    };
  }
}

/**
 * Analyze query patterns for key collections
 */
async function analyzeQueryPatterns(db) {
  // Define collections to analyze and their common query patterns
  const collectionsToAnalyze = {
    'products': [
      { query: { 'sku': 1 }, description: 'Queries by SKU' },
      { query: { 'etsy_data.listing_id': 1 }, description: 'Queries by Etsy listing ID' },
      { query: { 'shopify_data.product_id': 1 }, description: 'Queries by Shopify product ID' },
      { query: { 'quantity_on_hand': 1 }, description: 'Queries by quantity on hand' }
    ],
    'orders': [
      { query: { 'order_id': 1 }, description: 'Queries by order ID' },
      { query: { 'marketplace': 1, 'status': 1 }, description: 'Queries by marketplace and status' },
      { query: { 'receipt_id': 1 }, description: 'Queries by receipt ID' },
      { query: { 'order_date': -1 }, description: 'Sorting by order date' }
    ]
  };
  
  const analysis = {};
  
  for (const [collectionName, queryPatterns] of Object.entries(collectionsToAnalyze)) {
    if (await collectionExists(db, collectionName)) {
      const collection = db.collection(collectionName);
      const indexes = await collection.indexes();
      
      // Check if each query pattern is covered by an existing index
      const patternAnalysis = [];
      
      for (const pattern of queryPatterns) {
        const covered = isQueryCoveredByIndex(pattern.query, indexes);
        
        patternAnalysis.push({
          pattern: pattern.query,
          description: pattern.description,
          coveredByIndex: covered.covered,
          coveringIndex: covered.indexName,
          recommendation: covered.covered ? null : `Consider adding an index for this query pattern`
        });
      }
      
      analysis[collectionName] = patternAnalysis;
    }
  }
  
  return analysis;
}

/**
 * Check if a collection exists
 */
async function collectionExists(db, collectionName) {
  const collections = await db.listCollections({ name: collectionName }).toArray();
  return collections.length > 0;
}

/**
 * Check if a query pattern is covered by an existing index
 */
function isQueryCoveredByIndex(queryPattern, indexes) {
  // For simplicity, we're just checking if all fields in the query pattern are present
  // in any index in the same order. In reality, MongoDB's index selection is more complex.
  const queryFields = Object.keys(queryPattern);
  
  for (const index of indexes) {
    const indexKeys = Object.keys(index.key);
    
    // Skip _id default index as it only covers _id queries
    if (indexKeys.length === 1 && indexKeys[0] === '_id') {
      continue;
    }
    
    // Check if all query fields are covered by this index
    const allFieldsCovered = queryFields.every(field => 
      indexKeys.includes(field) && 
      // Check if the sort direction matches (1 for ascending, -1 for descending)
      index.key[field] === queryPattern[field]
    );
    
    if (allFieldsCovered) {
      return { covered: true, indexName: index.name };
    }
  }
  
  return { covered: false, indexName: null };
}

/**
 * Generate recommendations based on the analysis
 */
function generateRecommendations(indexAnalysis, queryPatternAnalysis) {
  const recommendations = [];
  
  // Check for collections with high index overhead
  for (const [collectionName, analysis] of Object.entries(indexAnalysis)) {
    if (parseFloat(analysis.indexOverhead) > 0.5) {
      recommendations.push({
        type: 'index_overhead',
        severity: 'medium',
        collection: collectionName,
        recommendation: `High index overhead (${analysis.indexOverhead}) for collection '${collectionName}'. Consider reviewing and removing unused indexes.`
      });
    }
    
    // Check for very large indexes
    for (const index of analysis.indexes) {
      if (index.sizeInMB > 100) {
        recommendations.push({
          type: 'large_index',
          severity: 'medium',
          collection: collectionName,
          index: index.name,
          recommendation: `Large index '${index.name}' (${index.sizeInMB.toFixed(2)}MB) in collection '${collectionName}'. Review if this index is necessary.`
        });
      }
    }
    
    // Check for duplicate or similar indexes
    const indexKeyStrings = analysis.indexes.map(idx => idx.keys);
    const similarIndexes = findSimilarIndexes(indexKeyStrings);
    
    if (similarIndexes.length > 0) {
      for (const group of similarIndexes) {
        recommendations.push({
          type: 'similar_indexes',
          severity: 'medium',
          collection: collectionName,
          indexes: group,
          recommendation: `Similar indexes found in collection '${collectionName}': ${group.join(', ')}. Consider consolidating these indexes.`
        });
      }
    }
  }
  
  // Add recommendations for missing indexes
  for (const [collectionName, patterns] of Object.entries(queryPatternAnalysis)) {
    for (const pattern of patterns) {
      if (!pattern.coveredByIndex) {
        recommendations.push({
          type: 'missing_index',
          severity: 'high',
          collection: collectionName,
          query: pattern.pattern,
          description: pattern.description,
          recommendation: `Create an index for ${pattern.description} on collection '${collectionName}'. Example: db.${collectionName}.createIndex(${JSON.stringify(pattern.pattern)})`
        });
      }
    }
  }
  
  return recommendations;
}

/**
 * Find similar indexes that might be redundant
 */
function findSimilarIndexes(indexKeyStrings) {
  const similarGroups = [];
  const processed = new Set();
  
  for (let i = 0; i < indexKeyStrings.length; i++) {
    if (processed.has(i)) continue;
    
    const currentKey = indexKeyStrings[i];
    const similarKeys = [currentKey];
    
    for (let j = i + 1; j < indexKeyStrings.length; j++) {
      if (processed.has(j)) continue;
      
      const otherKey = indexKeyStrings[j];
      
      // Check if keys are prefixes of each other
      if (currentKey.startsWith(otherKey.substring(0, otherKey.length - 1)) || 
          otherKey.startsWith(currentKey.substring(0, currentKey.length - 1))) {
        similarKeys.push(otherKey);
        processed.add(j);
      }
    }
    
    processed.add(i);
    
    if (similarKeys.length > 1) {
      similarGroups.push(similarKeys);
    }
  }
  
  return similarGroups;
}

// Run the analysis if this script is called directly
if (require.main === module) {
  analyzeIndexes()
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
  module.exports = analyzeIndexes;
}
