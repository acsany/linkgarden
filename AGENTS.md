# Repository guidance

README.md describes product behavior and security boundaries. Use Node 24. Run `npm run check`, `npm test`, and `npm run build` after changes. Browser tests are `npm run test:e2e` and `npm run test:pwa` (the latter requires a build).

The backend is in `server/`, the Vue frontend in `src/`, shared Zod schemas in `shared/`, and integration and browser tests in `tests/`. Add schema changes as new transactional migrations in `server/db.ts`. Add agent tools to `server/tools.ts` so the MCP and browser tool surfaces stay in sync. Never commit `.env`, local databases, uploads, exports, or production data.
