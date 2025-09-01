---
applyTo: "**"
---

# Endpoint & Feature Matrix

This document inventories the HTTP endpoints implemented in the project, the features available at each endpoint (based on both the route handlers and the Handlebars templates), a short assessment of implementation completeness, any mismatches or likely bugs, and suggestions for consolidation where similar behavior can be refactored into helpers.

## Methodology

- I inspected route handlers under `routes/` and the corresponding templates in `views/` to determine what each endpoint provides.
- Status classification: "Not implemented", "Partially implemented", "Fully implemented". These are judgement calls based on code paths, template wiring, TODO notes, and obvious missing dependencies (modals/elements or expected template variables).

## Summary checklist

```markdown
- [x] Inventory endpoints (GET/POST) analyzed against `views/inventory.hbs` and `views/inventory-gallery.hbs`
- [x] Orders endpoints (GET/POST) analyzed against `views/orders.hbs`, `views/order-details.hbs`, `views/orders-sku-view.hbs`
- [x] Sync endpoints reviewed against `services/*-sync-service.js` references and `views/sync.hbs` usage
- [x] Settings & Auth endpoints reviewed and cross-checked with templates
- [x] Debug endpoints checked
- [x] Feature grouping and similarity analysis completed
```

## Endpoints (by route file)

Notes: I list the actual route, the main features observed, and a short status + relevant observations.

### routes/orders.js

- GET /orders/view
  - Features: SKU-needs view (aggregate SKUs from open orders), sku-day grouped by date, sorting, pagination, product lookup (title/image/availability) via `Product` model, renders `orders-sku-view.hbs`.
  - Status: Fully implemented
  - Notes: Server-side aggregation is solid. Template `orders-sku-view.hbs` implements pagination and mobile adjustments.

- GET /orders/:id
  - Features: Show order details (searches by order_id, receipt_id, shopify_order_number), renders `order-details.hbs` with order object and activeMarketplace.
  - Status: Fully implemented

- GET /orders
  - Features: Lists unshipped, recently shipped, and cancelled orders; marketplace filter (etsy/shopify/all); counts for Etsy/Shopify totals; renders `orders.hbs`.
  - Status: Partially implemented
  - Notes: TODOs at top of file mention cancelled orders being incorrectly shown as unshipped; the query heuristics are present but may not cover all edge cases (cancel status detection differs between Etsy/Shopify). Counts are computed but rely on conventions (receipt_id presence, marketplace field).

- POST /orders/:id/sync-status (Etsy)
  - Features: Calls Etsy API to refresh a receipt, rewrites `order.items` (sets is_digital), runs `order.updateFromEtsy(receipt)`, stores `etsy_order_data` and saves.
  - Status: Partially implemented
  - Notes: Works if `process.env.TOKEN_DATA` and shop id are present; error paths return 500. Relies on `etsyRequest` pool helper.

- POST /orders/:id/sync-shopify-status
  - Features: Uses `shopify-helpers` client to fetch a Shopify order, maps line items to `order.items`, calls `order.updateFromShopify`, saves.
  - Status: Partially implemented
  - Notes: Depends on `shopify-helpers.getShopifyClient()` and `withRetries`. Requires env vars or saved settings for Shopify credentials.

- POST /orders/fix-statuses
  - Features: Bulk-fix order statuses using stored raw `etsy_order_data` (updates items, shipped flags, shipped_date), saves changed orders.
  - Status: Fully implemented for Etsy-backed data (intended use).

### routes/inventory.js

- GET /inventory
  - Features: Renders `inventory-gallery` view with `totalCount` and `columns` (via `getInventoryViewData`), initial gallery view.
  - Status: Fully implemented

- GET /inventory/table
  - Features: Renders `inventory` (table) view (same data provider as gallery).
  - Status: Fully implemented

- GET /inventory/gallery
  - Features: Redirects to `/inventory`.
  - Status: Fully implemented (redirect)

- GET /inventory/api/data
  - Features: Paginated JSON API for inventory (page, limit, sort, order, search). Calculates thumbnail and quantity_available. Selects a conservative set of fields.
  - Status: Fully implemented

- GET /inventory/product/:sku
  - Features: Returns product JSON with calculated availability, shop domain fallback and boolean `shopifyConnected`.
  - Status: Fully implemented

- GET /inventory/details/:sku
  - Features: Renders `product-details.hbs` with product object, etsy/shopify connected flags, shopifyShopName. Calculates availability and includes rich metadata.
  - Status: Fully implemented

- GET /inventory/:sku/etsy-candidates
  - Features: Heuristic search that finds `ETSY-` SKUs that appear to match a Shopify product by token-matching on titles and images; returns scored candidates.
  - Status: Fully implemented

- POST /inventory/:sku/link-etsy
  - Features: Link a Shopify product (target sku) to an Etsy listing or ETSY- SKU; copies `etsy_data` onto target, attempts to write the SKU to Etsy listing (via `etsyHelpers.updateListingSku`), deletes ETSY- doc if it existed.
  - Status: Fully implemented (but with multiple external dependencies)
  - Notes: Non-blocking Etsy write (errors are captured but DB changes still applied). Uses `etsyHelpers.getListing` if ETSY doc not in DB.

- POST /inventory
  - Features: Accepts array `changes` and upserts each product via `updateOrCreateProduct` (create when not found). Returns 207 if some failed.
  - Status: Fully implemented

- POST /inventory/properties
  - Features: Adds a new property to all products via `Product.updateMany` (writes empty string value).
  - Status: Fully implemented

### routes/sync.js

- GET /sync
  - Features: Sync dashboard. Gathers product/order counts and last-sync times from `Settings`/models and renders `sync.hbs` with stats and `ongoingAutoSyncs`.
  - Status: Fully implemented

- GET /sync/sync-etsy
  - Features: Starts an Etsy product sync in background via `services/etsy-sync-service.js`; creates/initializes a sync status and returns JSON or redirects.
  - Status: Fully implemented (depends on service)

- GET /sync/sync-shopify
  - Features: Starts Shopify product sync (background) via `services/shopify-sync-service.js`.
  - Status: Fully implemented (depends on service)

- POST /sync/sync-orders
  - Features: Trigger order sync for a given marketplace (etsy/shopify). Starts service functions `syncEtsyOrders` / `syncShopifyOrders`.
  - Status: Fully implemented

- GET /sync/status/:syncId
  - Features: Returns current status for a syncId using `sync-status-manager`.
  - Status: Fully implemented

### routes/settings.js

- GET /settings
  - Features: Settings dashboard; determines whether Etsy/Shopify are connected, reads some env settings and uses `etsyRequest` to fetch shop name when connected; renders `settings.hbs`.
  - Status: Fully implemented

- POST /settings/general
  - Features: Saves general settings using `@dotenvx/dotenvx` (writes environment-like values), updates process.env, reconfigures scheduler.
  - Status: Fully implemented

- POST /settings/etsy
  - Features: Saves Etsy API key via `dotenv.set`, validates basic format, updates process.env.
  - Status: Fully implemented

- POST /settings/shopify
  - Features: Validates Shopify shop + token via `shopifyHelpers.getShopInfo`, saves if validated.
  - Status: Fully implemented

- POST /settings/advanced
  - Features: Saves advanced flags (AUTO_SYNC_ENABLED) and reconfigures scheduler.
  - Status: Fully implemented

- GET /settings/connect-etsy
  - Features: Starts OAuth PKCE flow for Etsy (generates code_verifier and state, stores in session or fallback to env, redirects to Etsy OAuth URL).
  - Status: Fully implemented
  - Notes: Relies on session middleware to store codeVerifier and oauthState (recommended).

- GET /settings/debug-session
  - Features: Returns minimal session values (codeVerifier, oauthState, cookies) for debugging.
  - Status: Fully implemented (dev-only)

- POST /settings/disconnect-etsy
  - Features: Clears stored Etsy token env variables.
  - Status: Fully implemented

- POST /settings/connect-shopify
  - Features: Saves Shopify credentials after validating via `shopifyHelpers.getShopInfo`.
  - Status: Fully implemented

- POST /settings/disconnect-shopify
  - Features: Clears Shopify credentials.
  - Status: Fully implemented

- GET /settings/shipping-profiles
  - Features: Returns Etsy shipping profiles (`getShippingProfiles`) and flags which profiles are currently selected in `process.env.SYNC_SHIPPING_PROFILES`.
  - Status: Fully implemented

- POST /settings/shipping-profiles
  - Features: Saves selected shipping profile IDs to `process.env` via dotenv.
  - Status: Fully implemented

### routes/auth.js

- GET /oauth/redirect
  - Features: OAuth callback handler — exchanges code + PKCE verifier for token, stores token via `auth-service.saveNewToken`, clears session verifier/state, redirects to `/`.
  - Status: Fully implemented
  - Notes: Requires session storage for PKCE; has sensible fallback that uses `process.env.CLIENT_VERIFIER` but that is less secure.

- GET /oauth/welcome
  - Features: Renders `welcome.hbs` using a user fetch by user id derivation from `access_token` query param.
  - Status: Partially implemented
  - Notes: Route expects `access_token` in query and parses `user_id = access_token.split('.')[0]`, which is fragile. In normal OAuth flow the server should use stored token data rather than reading token from query param.

### routes/debug.js

- GET /debug/backfill-stale-orders
  - Features: Returns counts & samples for stale orders (Etsy/Shopify) to help backfill decisioning.
  - Status: Fully implemented

- GET /debug/etsy-test
  - Features: Renders `debug-etsy-test.hbs` (dev only) to test updateListingSku
  - Status: Fully implemented (dev-only)

- POST /debug/etsy-test
  - Features: Calls `etsyHelpers.updateListingSku(listingId, sku)` and returns result; dev-only.
  - Status: Fully implemented (dev-only)

## Template / UI mismatches and issues found

- Missing modal HTML: Several templates (both `inventory.hbs` and `inventory-gallery.hbs`) contain JavaScript that expects a modal with id `addProductModal` and a button with id `saveProduct`. I did not find modal markup in those templates. The JS defensively logs a warning when the modal isn't found; user experience will be incomplete (Add Product flow will fail unless the modal partial is included). Fix: add the modal partial to templates or centralize the modal HTML in `layouts/main.hbs` or a partial.

- process.env usage inside templates: `order-details.hbs` contains `https://{{process.env.SHOPIFY_SHOP_NAME}}/admin/orders/{{order.order_id}}`. Handlebars will not have `process.env` unless the server explicitly exposes it during render. In `routes/inventory.js` the `product-details` route sets `shopifyShopName` and passes it to the template — prefer using the explicit variable (e.g., `shopifyShopName`) rather than `process.env` in templates.

- OAuth PKCE/session dependency: `GET /oauth/redirect` expects `req.session.codeVerifier` to exist. If sessions are not properly configured, the flow falls back to `process.env.CLIENT_VERIFIER`, which is less safe and may cause mismatches in multi-user environments. Ensure express-session (or equivalent) is configured and that session persistence is used in deployment.

- Order cancellation detection: There are TODO comments indicating cancelled orders may show as unshipped; the route uses multiple heuristics which may not be perfectly accurate for edge cases. Consider unifying marketplace order state normalization in a helper.

## Feature grouping and where features appear

- Product listing / pagination / search
  - Endpoints: GET /inventory, GET /inventory/table, GET /inventory/api/data
  - Templates: `inventory.hbs`, `inventory-gallery.hbs`

- Product details / images / raw data
  - Endpoints: GET /inventory/product/:sku, GET /inventory/details/:sku
  - Templates: `product-details.hbs`

- Product create/update / bulk save
  - Endpoints: POST /inventory (bulk upsert), POST /inventory/properties
  - Templates: `inventory.hbs` Handsontable save button, `inventory-gallery.hbs` Add Product flow

- Link Shopify <-> Etsy products
  - Endpoints: POST /inventory/:sku/link-etsy, GET /inventory/:sku/etsy-candidates
  - Templates: product-details / inventory JS triggers

- Orders listing and SKU needs view
  - Endpoints: GET /orders, GET /orders/view
  - Templates: `orders.hbs`, `orders-sku-view.hbs`

- Order details and per-order sync
  - Endpoints: GET /orders/:id, POST /orders/:id/sync-status (Etsy), POST /orders/:id/sync-shopify-status
  - Templates: `order-details.hbs` (Sync buttons wired)

- Sync orchestration (background)
  - Endpoints: GET /sync, GET /sync/sync-etsy, GET /sync/sync-shopify, POST /sync/sync-orders, GET /sync/status/:syncId
  - Notes: Sync endpoints all follow a common pattern: create a syncId, initialize `sync-status-manager`, call a service in background, update status. Good candidate for consolidation of the sync-start pattern into a small helper.

- Settings & credentials
  - Endpoints: GET /settings, `POST /settings/*` (general, etsy, shopify, advanced), GET /settings/connect-etsy, POST /settings/connect-shopify, `POST /settings/disconnect-*`

## Similarity / Consolidation opportunities (high-value)

1. Order sync & status refresh
   - Problem: `POST /orders/:id/sync-status` (Etsy) and `POST /orders/:id/sync-shopify-status` (Shopify) perform highly similar tasks: fetch fresh remote order/receipt, normalize items, call model updater, save. They differ only in marketplace-specific API calls and small mapping details.
   - Suggestion: Create a single `syncOrderStatus({ marketplace, orderId, shopifyOpts })` helper that accepts a marketplace enum and a pluggable adapter for fetching remote data (Etsy adapter, Shopify adapter). This reduces duplication and centralizes error handling and audit logging.

2. Product thumbnail selection and shopify URL logic
   - Problem: Thumbnail picking logic and shop URL resolution appear in multiple places (inventory API and product-details modal JS). Consolidate into server-side helper(s): `getProductThumbnail(product)` and `buildShopifyUrl(product, shopifyShopName)` and expose their output consistently in the JSON rendered to templates.

3. Starting background syncs
   - Problem: Both `/sync/sync-etsy` and `/sync/sync-shopify` follow identical patterns to initialize sync status, call service, and report immediate result. Make a small helper `startBackgroundSync({ marketplace, type, serviceFn, req })` to standardize behavior and reduce duplicated try/catch/redirect logic.

4. Settings persistence via dotenvx
   - Problem: Several routes call `dotenv.set(...)` in similar ways and also update `process.env`. Wrap that behavior in a `Settings.save(key, value, { encrypt })` helper so callers get a consistent API and error handling.

5. Template partials and modal markup
   - Problem: Multiple pages expect the same modals (`addProductModal`, product details modal). Create a Handlebars partial for shared modals and include the partial in `layouts/main.hbs` or the inventory templates to avoid repeated JS checks and to guarantee the modal exists.

## Quick action items (recommended next steps)

1. Add missing modal partials used by `inventory.hbs` / `inventory-gallery.hbs` (IDs: `addProductModal`, `saveProduct` button) or remove/adjust JS which assumes their presence. (High priority — UI is broken without it.)
2. Replace in-template `process.env.*` usage with explicit variables passed from route handlers (e.g., `shopifyShopName`) to avoid template binding failures. (Medium priority)
3. Implement consolidation helpers suggested above (order sync adapter, product helpers, sync starter, settings wrapper) and add unit tests for them. (Medium priority)
4. Review OAuth PKCE/session setup and ensure session middleware is present and configured for production-safe storage. (High priority for auth flows)

## Prioritized Todo Checklist

- ~~[] Add missing modal partials used by `inventory.hbs` / `inventory-gallery.hbs` (IDs: `addProductModal`, `saveProduct` button) — High priority (urgent)~~
  - Replacement: remove Add Product access from the UI and annotate code paths as incomplete/possibly-removed.
  - Steps: remove Add Product buttons/links from `inventory.hbs`, `inventory-gallery.hbs`, and client JS; add TODO comments in `routes/inventory.js`, `views/*` client JS and any helper files noting the feature is disabled and may be removed (e.g., `// TODO(feature-flag): Add Product flow disabled — consider removal`).
  - Success: No Add Product buttons or modal triggers are visible on inventory pages; browser console no longer shows "modal not found" warnings; relevant files contain TODO comments.

- ~~[] Ensure modal partials are included in `layouts/main.hbs` so inventory JS finds expected elements everywhere — High priority (urgent)~~
  - Replacement: ensure layout does not include the Add Product modal and document the removal.
  - Steps: remove any `{{> addProductModal}}` includes from `layouts/main.hbs` or gate them behind a clear feature flag/comment; add a comment in `layouts/main.hbs` explaining the Add Product UI is intentionally disabled.
  - Success: `layouts/main.hbs` contains a comment indicating the Add Product modal is disabled and pages show no Add Product controls.
- [ ] Replace all direct `process.env.*` usages inside templates with explicit route variables (e.g., `shopifyShopName`) and update routes to pass them — High priority (urgent)
  - Steps: find templates referencing `process.env` (repo search), replace with variable names, update corresponding `res.render()` calls to include variables; run the server and inspect rendered HTML for missing placeholders.
  - Success: No template contains `process.env.*`; rendered pages show correct shop names/links; automated render spot-checks (3 pages) display expected values.
- [ ] Ensure express-session middleware is configured and documented so PKCE OAuth (code_verifier/state) works reliably; remove fallback reliance on `process.env.CLIENT_VERIFIER` — High priority (urgent)
  - Steps: verify `server.js` includes `express-session` setup (store, secret, cookie options); add README section documenting session requirements; remove or guard fallback to `CLIENT_VERIFIER` and log warnings if session missing.
  - Success: OAuth connect flow stores/verifies `codeVerifier` in `req.session`; end-to-end PKCE flow completes in a manual test; no insecure fallback used in normal operation.
- [ ] Audit and normalize order-state detection (cancelled/shipped/unshipped); implement a single helper to determine canonical order status across marketplaces and update queries in `routes/orders.js` — High priority (urgent)
  - Steps: implement `utils/order-status.js` exporting `normalizeOrderState(order)`; refactor `routes/orders.js` to use normalized states in queries and displays; add unit tests for sample Etsy/Shopify payloads.
  - Success: Unit tests pass for state normalization; `GET /orders` returns correct buckets (unshipped/shipped/cancelled) on a test dataset; no regressions in order UI.
- [ ] Add unit tests for new helpers and (instead of an Add Product integration test) verify UI removal and add a small test asserting no Add Product elements exist — High priority (urgent)
  - Steps: add Jest/Mocha tests under `test/` for helpers (thumbnail, URL, settings wrapper); add a DOM test (Jest+jsdom or Playwright smoke) that loads the inventory page and asserts Add Product button/modal are absent.
  - Success: Helper unit tests pass; DOM test confirms Add Product UI removed and no client-side errors occur when inventory pages load.
- [ ] Run QA/smoke tests after changes: build/launch server, verify Add Product UI removed, exercise inventory save (via API), order sync buttons, and OAuth PKCE flow; document results — High priority (urgent)
  - Steps: create a short QA checklist script in `test-scripts/` that runs the server, hits endpoints, and runs a browser smoke test asserting Add Product UI absent; capture screenshots/logs.
  - Success: QA checklist completes without errors; screenshots/logs stored under `tmp_run_results/` and added to PR.

- [ ] Add server-side helpers `getProductThumbnail(product)` and `buildShopifyUrl(product, shopifyShopName)` and update inventory API and `product-details` to return these fields; replace duplicated thumbnail/URL resolution logic in templates/JS with these server-provided values — Medium priority
  - Steps: add `utils/product-helpers.js` with `getProductThumbnail` and `buildShopifyUrl`; update `routes/inventory.js` to use helpers when producing JSON and rendering templates; remove client-side duplicates.
  - Success: Inventory API responses include `thumbnail` and `shopifyUrl` fields; templates use those fields and tests confirm URLs/images resolve in sample data.
- [ ] Create `startBackgroundSync({ marketplace, type, serviceFn, req })` helper to standardize sync-start behavior (init status, background call, error handling) and refactor `/sync/*` routes to use it — Medium priority
  - Steps: implement helper in `utils/sync-starter.js`, update `routes/sync.js` to call it for Etsy/Shopify sync starts, add unit tests for status lifecycle.
  - Success: Sync endpoints return consistent JSON (`syncId`, `status`) and sync-status-manager shows expected lifecycle entries; no duplicated try/catch logic remains.
- [ ] Implement unified order sync/status helper `syncOrderStatus({ marketplace, identifier })` (adapter pattern) and refactor `POST /orders/:id/sync-status` and `POST /orders/:id/sync-shopify-status` to call it — Medium priority
  - Steps: create `services/order-sync-adapter.js` with adapters for Etsy and Shopify; refactor routes to call a single helper; add tests mocking external APIs.
  - Success: Both POST sync routes call the adapter and update order documents identically for equivalent payloads; adapter unit tests pass.
- [ ] Centralize `dotenvx`/settings writes into a `Settings.save(key, value, { encrypt })` helper to standardize persistence and `process.env` updates — Medium priority
  - Steps: add `utils/settings-wrapper.js` that wraps `@dotenvx/dotenvx` calls and updates `process.env`; replace direct `dotenv.set` usages in routes with the wrapper.
  - Success: All writes go through `Settings.save`; no code calls `dotenv.set` directly; unit tests assert `process.env` values updated after save.
- [ ] Add runtime checks and clearer error messages when external credentials are missing (Shopify/Etsy) so endpoints return helpful errors instead of failing silently — Medium priority
  - Steps: add validation helper used by routes that depend on external creds (throw 400 with helpful message if missing); update UI to surface messages where appropriate.
  - Success: Endpoints return 400/422 with clear messages when creds missing; CI tests for protected endpoints validate error responses.
- [ ] Update `views` to stop referencing `process.env` directly; perform a repo-wide search-and-replace and update routes to pass the explicit variables — Medium priority
  - Steps: run a repo search for `process.env.` occurrences in `views/`; replace with variables and update `res.render()` calls; add a linter rule to warn on `process.env` in templates.
  - Success: No `process.env.*` remaining in `views/`; render-time smoke checks pass.
- [ ] Add/adjust Handlebars partial(s) for shared UI elements (modals, product card snippet) and include where relevant to reduce template duplication — Low priority
  - Steps: create `views/partials/product-card.hbs` and reuse in inventory templates; document partials in README.
  - Success: Fewer duplicated template blocks; visual UI unchanged; diff shows templates include partial instead of duplicate markup.
- [ ] Add/verify sync-status retention/cleanup behavior (ensure old sync status entries expire) and document behavior in `docs/` — Low priority
  - Steps: implement TTL or scheduled cleanup for sync status collection; add documentation under `docs/sync.md` describing retention policy.
  - Success: Old sync status entries removed after retention window in test DB; docs updated with retention policy.
- [ ] Update `docs/endpoints-features.md` with migration notes after implementing each consolidated helper and include short usage examples — Low priority
  - Steps: after implementing a helper, add a short migration note and example to this file and commit as part of the feature PR.
  - Success: Each refactor PR includes an updated section in this doc explaining how to migrate existing calls.
- [ ] Fix any remaining markdown lint issues and run the linter once more — Trivial
  - Steps: run markdownlint on the `docs/` folder, fix reported issues, commit changes.
  - Success: markdownlint exits with no errors for `docs/`.

## Closing notes

This inventory should be a solid starting framework for refactoring. The routes are generally implemented and wired to templates; the primary problems are a few template/UI mismatches (missing modal HTML and direct use of `process.env` in templates) and duplicated patterns in sync/order flows that are good candidates for helper extraction.

If you want, I can:

- Create the missing modal partial(s) and insert them into the relevant templates.
- Implement one of the consolidation helpers (for example, the unified order status sync helper) and update the routes to use it.
- Add unit tests for any helper I add.
