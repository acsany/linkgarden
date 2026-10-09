# Linkgarden

Linkgarden is a single-admin app for short URLs and link collections. One Node 24 process serves a Vue 3 frontend, an Express API, and authenticated MCP tools; PostgreSQL stores pages, analytics, and normalized image previews. This repository is a sanitized source snapshot with fresh history. It includes no hosted data or live deployment configuration. The project originated as a private application by Philipp Acsany, developed with AI assistance.

## Run locally

```sh
npm ci
cp .env.example .env
npm run admin:setup
npm run dev
```

Open http://localhost:3000/admin. The development database uses PGlite in ignored `.data/`; uploaded PDFs use ignored `.data-files/`. Keep `APP_ORIGIN` aligned with the URL you visit. `npm run admin:setup` writes a scrypt password hash to ignored `.env`.

## What it does

Pages can redirect to one URL or show ordered links, headings, PDFs, and video embeds. Public link pages have light and dark themes. The admin can inspect visit and click analytics, configure icon rules, import image previews through the authenticated API, and create read or write MCP tokens. Campaign codes attribute visits and clicks to assigned recipients. Public Markdown representations support clients that cannot run JavaScript. A link page's social preview (`og:image`) is a generated 1200×630 card with a QR code of the page URL in the theme's light colors. Saving draws the card, campaign URLs get their own, and a renamed slug or new theme changes the image URL so platforms fetch the new card. Renaming a slug does not redirect the old URL, so QR codes of it stop working.

The server uses a PostgreSQL compatible schema with versioned migrations. For production, set `APP_ORIGIN` to an HTTPS origin, `DATABASE_URL` to PostgreSQL, and `FILES_DIR` to persistent storage. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` through the setup command. Deployment infrastructure is deliberately left to the operator. Run `npm run build`, then `npm start`.

## Security and privacy boundaries

Admin sessions use scrypt password hashes, hashed session tokens, origin checks, and CSRF tokens. MCP uses separate scoped bearer tokens. Public page responses exclude private notes. URL previews are fetched with IP and redirect checks and bounded downloads. PDFs are served as attachments through counted routes.

Stored preview thumbnails have public, long-lived URLs even if a page is later archived or inactive. Only use images fit for public disclosure. Campaign codes and campaign-only pages are unlisted tracking links, not strong confidentiality controls; short or custom codes can be guessed, and `noindex` is crawler guidance. Do not use them to protect sensitive documents. Public visits, including Markdown reads by bots, can enter analytics.

## Verify

```sh
npm run check
npm test
npm run build
npx playwright install chromium webkit
npm run test:e2e
npm run test:pwa
```

`npm test` uses PGlite by default. `TEST_DATABASE_URL` instead uses and truncates a real PostgreSQL test database, so use a dedicated one. Browser tests start their own local servers.

No license is granted yet. Source visibility alone does not grant reuse rights. Security reports: see [SECURITY.md](SECURITY.md).
