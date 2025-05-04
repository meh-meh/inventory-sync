/**
 * Configure Handlebars helpers for the application
 * @param {Object} hbs - The Handlebars instance
 */
function configHandlebarsHelpers(hbs) {
    // Convert objects to JSON strings safely
    hbs.registerHelper('json', function(context) {
        try {
            // Safely convert mongoose documents to plain objects
            const plainObject = context.toObject ? context.toObject() : context;
            
            // Process the object to make it safe for stringify
            const safeObj = safeStringify(plainObject);
            return JSON.stringify(safeObj, null, 2);
        } catch (error) {
            console.error('Error in json helper:', error);
            return '"[Error: Unable to stringify object]"';
        }
    });

    // Format dates to localized strings
    hbs.registerHelper('formatDate', function(date) {
        if (!date) return '';
        return new Date(date).toLocaleDateString();
    });

    // Multiply two numbers
    hbs.registerHelper('multiply', function(a, b) {
        return a * b;
    });

    // Divide first number by second number
    hbs.registerHelper('divide', function(a, b) {
        if (b === 0) return 0;
        return a / b;
    });

    // Check equality between two values
    hbs.registerHelper('eq', function(a, b) {
        return a === b;
    });

    // Get array length
    hbs.registerHelper('length', function(arr) {
        return Array.isArray(arr) ? arr.length : 0;
    });

    // Check if first value is less than second
    hbs.registerHelper('lt', function(a, b) {
        return a < b;
    });

    /**
     * Handlebars helper to check if two values are equal
     * @param {*} a - First value
     * @param {*} b - Second value
     * @param {Object} options - Handlebars options object
     * @returns {String} - Rendered block if equal, otherwise inverse block
     */
    hbs.registerHelper('ifeq', function(a, b, options) {
        if (a === b) {
            return options.fn(this);
        } else {
            return options.inverse(this);
        }
    });

    /**
     * Handlebars helper to check if two values are not equal
     * @param {*} a - First value
     * @param {*} b - Second value
     * @param {Object} options - Handlebars options object
     * @returns {String} - Rendered block if not equal, otherwise inverse block
     */
    hbs.registerHelper('ifnoteq', function(a, b, options) {
        if (a !== b) {
            return options.fn(this);
        } else {
            return options.inverse(this);
        }
    });

    /**
     * Handlebars helper for logical OR condition
     * @param {*} a - First condition
     * @param {*} b - Second condition
     * @param {Object} options - Handlebars options object
     * @returns {String} - Rendered block if either condition is truthy, otherwise inverse block
     */
    hbs.registerHelper('or', function(a, b, options) {
        if (a || b) {
            return options.fn(this);
        } else {
            return options.inverse(this);
        }
    });

    /**
     * Handlebars helper for logical AND condition
     * @param {*} a - First condition
     * @param {*} b - Second condition
     * @param {Object} options - Handlebars options object
     * @returns {String} - Rendered block if both conditions are truthy, otherwise inverse block
     */
    hbs.registerHelper('and', function(a, b, options) {
        if (a && b) {
            return options.fn(this);
        } else {
            return options.inverse(this);
        }
    });

    /**
     * Handlebars helper to check if an array or string includes a value
     * @param {Array|String} collection - The array or string to check
     * @param {*} value - The value to check for inclusion
     * @param {Object} options - Handlebars options object
     * @returns {String} - Rendered block if included, otherwise inverse block
     */
    hbs.registerHelper('includes', function(collection, value, options) {
        if (collection && collection.includes(value)) {
            return options.fn(this);
        } else {
            return options.inverse(this);
        }
    });

    // ...existing code...
}

/**
 * Creates a safe-to-stringify version of an object by handling circular references
 * and limiting the depth of nested objects
 * @param {Object} obj - The object to stringify
 * @param {Number} maxDepth - Maximum depth to traverse
 * @param {Number} currentDepth - Current traversal depth
 * @returns {Object} A stringify-safe object
 */
function safeStringify(obj, maxDepth = 6, currentDepth = 0) {
    // Base case for recursion - stop at max depth
    if (currentDepth > maxDepth) return "[Max Depth Reached]";

    if (typeof obj !== 'object' || obj === null) {
        return obj;
    }

    // Handle arrays
    if (Array.isArray(obj)) {
        return obj.map(item => safeStringify(item, maxDepth, currentDepth + 1));
    }

    // Handle objects
    const result = {};
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            // Special handling for image URLs to ensure they're not truncated
            if (key === 'url' || key === 'alt' || key === 'src') {
                result[key] = obj[key];
            }
            // Skip large text fields that might cause issues
            else if (typeof obj[key] === 'string' && obj[key].length > 5000) {
                result[key] = obj[key].substring(0, 200) + '... [truncated]';
            } 
            // Skip raw data fields that might be too large
            else if (key === 'raw_etsy_data') {
                result[key] = '[Large Data Object]';
            }
            else {
                result[key] = safeStringify(obj[key], maxDepth, currentDepth + 1);
            }
        }
    }
    return result;
}

module.exports = configHandlebarsHelpers;