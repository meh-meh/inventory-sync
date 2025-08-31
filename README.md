# Etsy Inventory Manager

A Node.js application for managing Etsy inventory and orders across multiple marketplaces.

## Prerequisites

- Node.js 14 or higher
- MongoDB installed and running locally
- An Etsy Developer account with API access

## Setup

1. Install dependencies:

    ```bash
    npm install
    ```

2. Create a `.env` file with your Etsy API credentials (see `.env.example` for required fields)
3. Make sure MongoDB is running locally on the default port (27017)

## Project Structure

```plaintext
├── models/             # Database models
│   ├── order.js        # Order model definition
# Etsy Inventory Manager

A Node.js application for managing Etsy inventory and orders across multiple marketplaces.

## Prerequisites

- Node.js 14 or higher (see `package.json` "engines")
- MongoDB accessible (local or remote)
- An Etsy Developer account with API access (API key and OAuth tokens)

## Setup

1. Install dependencies:

    ```bash
    npm install
    ```

2. Create a `.env` file in the project root with the required environment variables (example list below).

3. Ensure MongoDB is running or reachable via `MONGODB_URI`.

Required environment variables (commonly used by the app):

- ETSY_API_KEY
- TOKEN_DATA (JSON string with OAuth tokens)
- MONGODB_URI (e.g., mongodb://localhost:27017/etsy_inventory)
- SESSION_SECRET
- SHOPIFY_ACCESS_TOKEN (optional)
- SHOPIFY_SHOP_NAME (optional)
- DEFAULT_VIEW (optional, e.g., "gallery")
- LOW_STOCK_THRESHOLD (optional, integer)
- AUTO_SYNC_ENABLED (optional, true/false)
- AUTO_SYNC_INTERVAL (optional, hours)

If a sample `.env.example` is not present in this repo, create a `.env` with the keys above.

## Project Structure

```plaintext
├── models/             # Database models (product, order, settings)
├── routes/             # Express route handlers
├── utils/              # Helper functions and services
├── views/              # Handlebars templates and layouts
└── server.js           # Main application file
```

## Starting the Server

On macOS / Linux (zsh, bash):

1. Kill any existing node processes listening on the app port (optional):

    ```bash
    # kill by process name
    pkill -f node || true

    # or kill only processes on the default port
    lsof -i :3003 -t | xargs --no-run-if-empty kill || true
    ```

2. Start the server (use `PORT` to override default 3003):

    ```bash
    npm start
    # or
    PORT=4000 npm start
    ```

On Windows (PowerShell):

    Stop-Process -Name node -Force  # caution: kills all node processes

The server default address is http://localhost:3003 unless `PORT` is set in the environment.

Useful npm scripts (defined in `package.json`):

- `npm start` — run the app (node server.js)
- `npm run check-db` — runs a MongoDB health check script
- `npm run analyze-indexes` — analyze MongoDB indexes
- `npm run create-indexes` — create recommended indexes
- `npm run test-timeouts` — test timeout handling in scripts

## Features

- Sync inventory with Etsy
- Track order status and shipping
- Manage inventory levels
- View order details and history
- Filter orders by status (unshipped, shipped, canceled)
- Auto-refresh of Etsy OAuth tokens
- Support for physical and digital items
- Product image carousel in product details view
- Raw data inspection for advanced users

## Development Notes

- Use semantic commits for version control
- Run the MongoDB health check (`npm run check-db`) when troubleshooting DB issues
- Keep dependencies up to date
- Follow the established code organization pattern when adding new features
- After making template or helper changes, restart the server

## Troubleshooting

### Common Issues

#### Missing Helpers

If you encounter a "Missing helper" error, check `utils/handlebars-helpers.js` and ensure the helper is exported and registered in `server.js`.

#### Image Display Problems

If images aren't displaying properly:

1. Ensure image URLs are correctly formatted in the database
2. Verify the correct property is being used in the template (e.g., `url` vs `url_fullxfull`)
3. Check the browser console for 404 errors on image requests

#### Data Depth Issues

If you see `[Max Depth Reached]` in JSON views, the JSON helper may be truncating nested objects. Adjust the maxDepth parameter in the helper.

## MongoDB Management

### macOS

If you installed MongoDB via Homebrew:

```bash
brew services start mongodb-community
brew services stop mongodb-community
brew services list
```

Or run `mongod` directly with your config file:

```bash
mongod --config /usr/local/etc/mongod.conf
```

### Linux (systemd)

```bash
sudo systemctl start mongod
sudo systemctl stop mongod
sudo systemctl status mongod
```

### Windows (PowerShell)

```powershell
# Start/stop a MongoDB service if installed as a service
net start MongoDB
net stop MongoDB
Get-Service -Name MongoDB -ErrorAction SilentlyContinue
```

If MongoDB isn't starting, check the configured data directory and log files (often configured in `mongod.conf`).

## Where to look next

- `server.js` — application entrypoint and route mounting
- `routes/` — API and page routes
- `utils/` — API helpers (Etsy/Shopify), auth service, scheduler

---

If you want, I can also add a small `.env.example` file containing the keys above and a short `CONTRIBUTING.md` with development steps.
### Checking MongoDB Status
