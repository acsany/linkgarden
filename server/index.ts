import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mountBuiltFiles } from './static.js';
import { getConfig } from './config.js';
import { openDb, migrate } from './db.js';
import { seedAdmin } from './auth.js';
import { createApp } from './app.js';
const config = getConfig();
const db = await openDb(config);
await migrate(db);
await seedAdmin(db, config);
let vite: any;
if (!config.production) {
  const { createServer } = await import('vite');
  vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
}
const template = config.production ? await readFile(resolve('dist/index.html'), 'utf8') : '';
const built = createApp(db, config, async (req) =>
  config.production
    ? template
    : vite.transformIndexHtml(req.originalUrl, await readFile(resolve('index.html'), 'utf8')),
);
// Fails startup when the upload directory (the persistent disk on Render) is not writable.
await built.service.files.init();
if (vite) built.app.use(vite.middlewares);
else mountBuiltFiles(built.app);
built.finish();
await built.service.cleanup();
// Stores images of existing links in the background, so public pages, which never
// hotlink, regain them without blocking startup. Never fills links without an image.
const cachePreviews = () =>
  built.service.previews
    .backfill({ fill: false, limit: Infinity })
    .catch(() => console.error('Preview caching failed'));
void cachePreviews();
const maintenance = setInterval(
  () =>
    built.service
      .cleanup()
      .then(cachePreviews)
      .catch(() => console.error('Maintenance failed')),
  6 * 3600000,
);
maintenance.unref();
const server = built.app.listen(config.port, config.host, () =>
  console.log(
    `Linkgarden: ${config.origin}\nAdmin: ${config.origin}/admin\nMCP: ${config.origin}/mcp (bearer token required)`,
  ),
);
// Long enough for a maximum-size PDF upload over a slow mobile connection.
server.requestTimeout = 120000;
server.headersTimeout = 15000;
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(maintenance);
  server.close(async () => {
    await Promise.all([built.readMcp.close(), built.writeMcp.close()]);
    if (vite) await vite.close();
    await db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
