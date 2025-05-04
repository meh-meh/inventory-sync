const winston = require('winston');

// Create a logger with consistent formatting
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        // Write logs to a file
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        // Also log to console with simpler formatting
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// Add method to track API rate limits
let lastRequestTime = 0;
const rateLimitDelay = 100; // 100ms between requests (10 req/sec)

async function trackRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < rateLimitDelay) {
        await new Promise(resolve => setTimeout(resolve, rateLimitDelay - timeSinceLastRequest));
    }
    lastRequestTime = Date.now();
}

module.exports = {
    logger,
    trackRateLimit
};