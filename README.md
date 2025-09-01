
# Etsy Inventory Manager (inventory-sync)

This repository is a Node.js + Express application for managing inventory and orders across Etsy and Shopify marketplaces. It provides synchronization utilities, route handlers, Handlebars views, background scheduling, and a set of local test utilities.

![Smoke tests](https://github.com/meh-meh/inventory-sync/actions/workflows/smoke-tests.yml/badge.svg)

## Quick start

Install dependencies:

```powershell
npm install
```

Start the application (development):

```powershell
npm start
```

By default the server listens on port 3003. Environment variables are loaded with `@dotenvx/dotenvx` via `server.js`.

Start in test mode (binds to the test MongoDB URI and sets NODE_ENV=test):

```powershell
npm run start:test
```

## Useful npm scripts

- `npm start` — runs `node server.js`
- `npm run start:test` — runs server with `NODE_ENV=test` and a test `MONGODB_URI` (see `package.json`)
- `npm run seed:test-db` — seeds the deterministic test DB from `data/test-db.json` (`scripts/load-test-db.js`)
- `npm test` — runs Jest tests (`cross-env NODE_ENV=test jest --runInBand`)
- `npm run smoke:playwright` / `npm run smoke:fallback` / `npm run smoke:dom` — DOM smoke test helpers (Playwright preferred, jsdom fallback)

Note: Playwright browser binaries are installed on-demand by the `postinstall` script when Playwright is present.

## Tests and test data

- Deterministic test data: `data/test-db.json`
- The `seed:test-db` script (`scripts/load-test-db.js`) will seed a MongoDB instance and mark documents with `is_test_data: true` for safe cleanup.
- Tests use Jest, Supertest and mongodb-memory-server to provide deterministic integration tests.

Run the full test suite locally:

```powershell
npm test
```

Run smoke tests (Playwright preferred):

```powershell
npm run smoke:playwright --silent

npm run smoke:dom
```

## Project structure

Top-level layout (important folders shown):

```text
├── models/             # Mongoose models (product, order, settings)
├── routes/             # Express route handlers (auth, inventory, orders, sync, settings, debug)
├── services/           # Marketplace sync services (etsy-sync-service.js, shopify-sync-service.js)
├── utils/              # Helper utilities (etsy-helpers, logger, cache, middleware, auth)
├── scripts/            # CLI scripts for maintenance and data tasks
├── test-scripts/       # Test helpers and smoke tests
├── views/              # Handlebars templates and layouts
└── server.js           # Main express app (view engine, middleware, routers, scheduler)
```

## Features (current)

- Synchronize inventory with Etsy (implemented)
- Shopify sync utilities and a Shopify sync service exist (partial/ongoing integration)
- Track and manage order status (unshipped, shipped, canceled)
- Background scheduler and optional startup sync (see `utils/scheduler.js`)
- Automatic token refresh and session-based OAuth flows
- Handlebars-based admin UI with helpers in `utils/handlebars-helpers.js`
- Deterministic test seeding and integration tests using mongodb-memory-server

## Progress summary

### Completed highlights

- Express app wired with modular route handlers (`routes/*`) and Handlebars views
- Background scheduler and startup sync are present and initialized by `server.js`
- Shopify helper/service scaffolding exists (`services/shopify-sync-service.js`) and several Shopify-related scripts are included
- Improved error handling and a centralized logger in `utils/logger.js`
- Handlebars helpers provided in `utils/handlebars-helpers.js`

### Short-term / planned work

- Complete and harden Shopify order sync and fulfillment flows
- Add bulk order status sync and bulk operations UI
- Improve search and export features for orders and inventory

### Long-term ideas

- Additional marketplace adapters (Amazon, eBay)
- Inventory forecasting and analytics
- Mobile-optimized UI and barcode/mobile scanning support

## Handlebars helpers

Helpers are defined in `utils/handlebars-helpers.js`. Examples include `json`, `formatDate`, `formatCurrency`, conditionals and small math helpers used by the templates.

## Development notes

- Use semantic commit messages and run tests before opening PRs
- Restart the server after template or helper changes
- Keep dependencies (Playwright, Jest, MongoDB tools) up to date

## MongoDB (Windows)

Start MongoDB service:

```powershell
net start MongoDB
```

Stop MongoDB service:

```powershell
net stop MongoDB
```

Check status:

```powershell
Get-Service -Name MongoDB -ErrorAction SilentlyContinue
```

## Sample data and utilities

See `test-scripts/` and `scripts/` for sample data loaders, index helpers and maintenance tasks. The deterministic `data/test-db.json` is intended for CI and local testing only.

## Notes

- Do not seed production databases with test data.
- Keep API credentials and secrets out of source control; use environment variables or a secrets manager.
