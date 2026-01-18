# Copilot instructions — inventory-sync

Purpose: give AI coding agents immediate, actionable knowledge to work in this repo.

## Big picture (how the app is wired)
- Single Express app (entry: [server.js](server.js)) that syncs Etsy + Shopify inventory and orders.
- Route handlers in [routes](routes) call service layer in [services](services), which orchestrates API calls and DB writes in [models](models).
- Platform helpers and shape conversions live in [utils](utils); see [utils/product-helpers.js](utils/product-helpers.js) and [utils/marketplace-helpers.js](utils/marketplace-helpers.js).
- Handlebars UI lives in [views](views) with helpers in [utils/handlebars-helpers.js](utils/handlebars-helpers.js).
- Startup scheduler and optional sync are initialized in [utils/scheduler.js](utils/scheduler.js) via [server.js](server.js).

## Data flow & conventions
- Request flow: routes → services → utils → models (see [routes/sync.js](routes/sync.js) and [services/etsy-sync-service.js](services/etsy-sync-service.js)).
- Orders can be a secondary source of truth; reference [scripts/backfill-stale-orders.js](scripts/backfill-stale-orders.js).
- Use `async/await` and log through `utils/logger.js` (avoid `console.log` in app code).
- DB access assumes a Mongo-like interface; see [config/database.js](config/database.js) and [models/index.js](models/index.js).

## Workflows (actual repo scripts)
- Local dev: `npm start` (loads env via dotenvx in [server.js](server.js); default port 3003).
- Test mode: `npm run start:test` (uses test Mongo URI from [package.json](package.json)).
- Seed deterministic DB: `npm run seed:test-db` (uses [data/test-db.json](data/test-db.json)).
- Tests: `npm test` (Jest + Supertest + mongodb-memory-server; see [tests/integration/api.test.js](tests/integration/api.test.js)).
- Smoke tests: `npm run smoke:playwright` (preferred) or `npm run smoke:dom` (see [test-scripts](test-scripts)).

## Integration points
- Etsy API schema: [Etsy_API_3.0.0.json](Etsy_API_3.0.0.json). Calls via [utils/etsy-helpers.js](utils/etsy-helpers.js) and [utils/etsy-request-pool.js](utils/etsy-request-pool.js).
- Shopify GraphQL helpers in [utils/shopify-helpers.js](utils/shopify-helpers.js); sync logic in [services/shopify-sync-service.js](services/shopify-sync-service.js).
- Auth/token handling in [utils/auth-service.js](utils/auth-service.js).

## Examples to follow
- Sync trigger path: [routes/sync.js](routes/sync.js) → [services/etsy-sync-service.js](services/etsy-sync-service.js).
- Product fields: [models/product.js](models/product.js) used across services and views.

If anything here is unclear or incomplete, say which sections to expand.
