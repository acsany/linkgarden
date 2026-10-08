// Test fixture: real built assets and HTTP routes with disposable embedded PostgreSQL.
// This does not change the production requirement for HTTPS and durable PostgreSQL.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app.js';
import { openDb, migrate } from '../server/db.js';
import { hashPassword, seedAdmin } from '../server/auth.js';
import { mountBuiltFiles } from '../server/static.js';
import type { Config } from '../server/config.js';
const config: Config = {
  production: false,
  port: 3200,
  host: '127.0.0.1',
  origin: 'http://localhost:3200',
  dataDir: ':memory:',
  filesDir: await mkdtemp(join(tmpdir(), 'linkgarden-pwa-files-')),
  maxUploadBytes: 25 * 1024 * 1024,
  pgSsl: false,
  adminEmail: 'browser@example.com',
  adminPasswordHash: await hashPassword('test-only-password-123'),
};
const db = await openDb(config);
await migrate(db);
await seedAdmin(db, config);
const template = await readFile(resolve('dist/index.html'), 'utf8');
const built = createApp(db, config, async () => template);
const worker = await readFile(resolve('dist/sw.js'), 'utf8');
let workerVersion = 0;
// The fixture alone can switch worker versions to exercise a real update lifecycle.
built.app.post('/__test/update-worker', (_req, res) => res.json({ version: ++workerVersion }));
built.app.get('/sw.js', (_req, res) => {
  res
    .set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' })
    .type('js')
    .send(
      workerVersion
        ? worker.replace(
            /linkgarden-static-([a-f0-9]+)/,
            `linkgarden-static-$1-test-${workerVersion}`,
          )
        : worker,
    );
});
mountBuiltFiles(built.app);
built.finish();
const server = built.app.listen(config.port, config.host);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.close(async () => {
    await Promise.all([built.readMcp.close(), built.writeMcp.close()]);
    await db.close();
    process.exit(0);
  });
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
