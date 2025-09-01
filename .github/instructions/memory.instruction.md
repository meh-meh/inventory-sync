---
applyTo: '**'
---

# User Memory

## User Preferences
- Programming languages: JavaScript/Node.js
- Code style preferences: Prettier, ESLint, kebab-case files, camelCase variables
- Development environment: VS Code on Windows
- Communication style: concise, actionable

## Project Context
- Project: Etsy Inventory synchronization app (Node.js + Express, Handlebars views)
- Key folders: `routes/`, `views/`, `utils/`, `services/`, `docs/`
- Known issues: Add Product modal missing, templates reference `process.env` directly, OAuth PKCE session dependency

## Current Task
- Goal: Work through prioritized checklist in `docs/endpoints-features.md` and implement replacement actions for crossed-out items.
- Current status: Removed Add Product UI from `views/inventory.hbs` and `views/inventory-gallery.hbs`; added layout comment; updated docs checklist.

## Files changed in this session
- `views/inventory.hbs` - removed Add Product button/JS and modal handlers; added TODO comments
- `views/inventory-gallery.hbs` - removed Add Product button/JS and modal handlers; added TODO comments
- `views/layouts/main.hbs` - added comment documenting Add Product modal removal
- `docs/endpoints-features.md` - updated checklist entries to reflect changes

## Next steps planned
1. Replace direct `process.env.*` usage in templates (search + update routes to pass explicit vars).
2. Verify `server.js` includes `express-session` configuration and document any missing setup.
3. Implement utility helpers (product-helpers, sync-starter) incrementally and add unit tests.

## Notes
- Do not store secrets in memory.
- Record progress in this memory file as tasks complete.

