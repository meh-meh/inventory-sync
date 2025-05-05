const moment = require('moment');
const { logger } = require('./logger'); // Import logger

/**
 * Safely prepares an object for JSON.stringify by handling potential circular references 
 * and converting complex types (like Mongoose objects) to plain objects.
 * 
 * @param {any} obj The object to process.
 * @param {WeakSet} [seen=new WeakSet()] Used internally to track visited objects.
 * @returns {any} A safe version of the object for stringification.
 */
function safeStringifyPrep(obj, seen = new WeakSet()) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    // Handle Mongoose documents
    if (obj.toObject) {
        obj = obj.toObject();
    }

    // Handle potential circular references
    if (seen.has(obj)) {
        return '[Circular Reference]';
    }
    seen.add(obj);

    if (Array.isArray(obj)) {
        return obj.map(item => safeStringifyPrep(item, seen));
    }

    const result = {};
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            result[key] = safeStringifyPrep(obj[key], seen);
        }
    }
    return result;
}

// Export helpers as an object
module.exports = function() { 
    return {
        // Convert objects to JSON strings safely
        json: function(context) {
            logger.debug('Handlebars json helper received:', { type: typeof context }); // Log input type
            // Avoid logging potentially large context object directly unless needed for deep debugging
            try {
                const safeObj = safeStringifyPrep(context);
                const jsonString = JSON.stringify(safeObj, null, 2);
                // logger.debug('Handlebars json helper returning string of length:', jsonString.length); // Log output length
                return jsonString;
            } catch (error) {
                logger.error('Error in json helper:', { errorMessage: error.message, stack: error.stack }); // Log error details
                return '"[Error: Unable to stringify object]"';
            }
        },

        // Format dates using moment.js
        formatDate: function(date, options) { // Renamed second arg to 'options'
            if (!date) {
                // logger.debug('formatDate helper received null/undefined date');
                return 'N/A';
            }
            
            // Get format string from hash arguments, or use default
            const fmt = typeof options?.hash?.format === 'string' 
                        ? options.hash.format 
                        : 'YYYY-MM-DD HH:mm:ss'; 
            
            // logger.debug('formatDate using format:', { format: fmt });

            try {
                const mDate = moment(date); 
                if (!mDate.isValid()) {
                    logger.warn('formatDate helper received invalid date:', { date });
                    return 'Invalid Date';
                }
                return mDate.format(fmt); 
            } catch (error) {
                // Log the error with more context
                logger.error('Error formatting date in formatDate helper:', { 
                    dateInput: date, 
                    resolvedFormat: fmt, 
                    errorMessage: error.message, 
                    stack: error.stack 
                });
                return 'Invalid Date'; // Return a safe value on error
            }
        },

        // Format currency
        formatCurrency: function(amount, currency = 'USD') {
            if (typeof amount !== 'number') return 'N/A';
            return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency }).format(amount);
        },

        // Simple equality check helper
        eq: function(a, b) {
            return a === b;
        },

        // Check if a value is included in an array or string
        includes: function(collection, value) {
            if (!collection) return false;
            return collection.includes(value);
        },

        // Get the length of an array or string
        length: function(collection) {
            if (!collection) return 0;
            return collection.length;
        },

        // Convert string to uppercase
        toUpperCase: function(str) {
            if (typeof str !== 'string') return '';
            return str.toUpperCase();
        },

        // Convert string to lowercase
        toLowerCase: function(str) {
            if (typeof str !== 'string') return '';
            return str.toLowerCase();
        },

        // Truncate text to a specified length
        truncate: function(text, length = 100, ellipsis = '...') {
            if (typeof text !== 'string' || text.length <= length) {
                return text;
            }
            return text.substring(0, length) + ellipsis;
        },

        // Add two numbers
        add: function(a, b) {
            return (Number(a) || 0) + (Number(b) || 0);
        },

        // Subtract two numbers
        subtract: function(a, b) {
            return (Number(a) || 0) - (Number(b) || 0);
        },

        // Multiply two numbers
        multiply: function(a, b) {
            return (Number(a) || 0) * (Number(b) || 0);
        },

        // Divide two numbers
        divide: function(a, b) {
            const numB = Number(b) || 0;
            if (numB === 0) return 'NaN'; // Avoid division by zero
            return (Number(a) || 0) / numB;
        },

        // Select an option in a dropdown if its value matches a given value
        selectOption: function(value, selectedValue) {
            return value === selectedValue ? 'selected' : '';
        },

        // Check if an object is empty
        isEmpty: function(obj) {
            if (obj === null || obj === undefined) return true;
            if (typeof obj === 'object') {
                return Object.keys(obj).length === 0;
            }
            if (Array.isArray(obj) || typeof obj === 'string') {
                return obj.length === 0;
            }
            return false; // Consider numbers, booleans etc. as not empty
        },

        // Generate pagination links (basic example)
        pagination: function(currentPage, totalPages, urlBase) {
            let html = '<ul class="pagination">';
            // Ensure currentPage is a number
            const current = Number(currentPage) || 1;
            for (let i = 1; i <= totalPages; i++) {
                html += `<li class="page-item ${i === current ? 'active' : ''}"><a class="page-link" href="${urlBase}?page=${i}">${i}</a></li>`;
            }
            html += '</ul>';
            // Return the raw HTML string. Use triple-stash {{{pagination ...}}} in the template.
            return html; 
        },

        // Get image URL, handling potential variations
        getImageUrl: function(product, size = 'full') {
            // Placeholder logic - adapt based on your actual product data structure
            if (product && product.images && product.images.length > 0) {
                const image = product.images[0]; // Use the first image
                switch (size) {
                    case 'thumbnail': return image.url_75x75 || image.url_fullxfull;
                    case 'medium': return image.url_170x135 || image.url_fullxfull;
                    default: return image.url_fullxfull;
                }
            } else if (product && product.image && product.image.src) {
                // Handle Shopify image structure
                return product.image.src;
            }
            return '/images/placeholder.png'; // Default placeholder
        },

        // Debug helper: Log context to console
        debug: function(optionalValue) {
            console.log("Current Context");
            console.log("====================");
            console.log(this);
        
            if (optionalValue) {
                console.log("Value");
                console.log("====================");
                console.log(optionalValue);
            }
        }
    };
};