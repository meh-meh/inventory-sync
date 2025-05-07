const winston = require('winston');
const path = require('path');

// Get project root (assuming logger.js is in utils/)
const projectRoot = path.resolve(__dirname, '..');
// Escape backslashes for regex on Windows
const projectRootRegex = new RegExp(projectRoot.replace(/\\/g, '\\'), 'g');

/**
 * Custom Winston format function that obscures project root path in stack traces and messages
 * for security and readability reasons
 *
 * @param {Object} info - The log info object
 * @returns {Object} Modified log info object with obscured paths
 */
const obscurePathFormat = winston.format(info => {
	if (info.stack) {
		info.stack = info.stack.replace(projectRootRegex, '[PROJECT_ROOT]');
	}
	// Also check the message itself, in case the stack is part of the message
	if (typeof info.message === 'string') {
		info.message = info.message.replace(projectRootRegex, '[PROJECT_ROOT]');
	}
	return info;
});

/**
 * Winston logger instance configured with file and console transports
 * Automatically formats logs with timestamps and obscures file paths for security
 */
const logger = winston.createLogger({
	level: process.env.LOG_LEVEL || 'info', // Use environment variable or default
	format: winston.format.combine(
		winston.format.timestamp(),
		obscurePathFormat(), // Apply custom format BEFORE json()
		winston.format.json()
	),
	transports: [
		// Write logs to a file
		new winston.transports.File({
			filename: 'error.log',
			level: 'error',
			// Apply format specifically to file transports if needed,
			// but combining it globally before json() is usually sufficient.
		}),
		new winston.transports.File({
			filename: 'combined.log',
		}),
		// Also log to console with simpler formatting (without path obscuring)
		new winston.transports.Console({
			format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
			level: process.env.CONSOLE_LOG_LEVEL || 'info', // Allow separate console level
		}),
	],
});

module.exports = {
	logger,
};
