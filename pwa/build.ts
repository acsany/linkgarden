import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

const files = [
  '/offline.html',
  '/manifest.webmanifest',
  '/icons/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
];
function worker(assets: string[], version: string) {
  return readFileSync(resolve('pwa/service-worker.js'), 'utf8')
    .replace('__CACHE_VERSION__', version)
    .replace('__PRECACHE__', JSON.stringify([...files, ...assets]));
}
export function pwa(): Plugin {
  return {
    name: 'linkgarden-pwa',
    configureServer(server) {
      server.middlewares.use('/sw.js', (_req, res) => {
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Service-Worker-Allowed', '/');
        res.end(worker([], 'development'));
      });
    },
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((name) => /^assets\/.*\.(?:js|css|woff2?)$/.test(name))
        .map((name) => `/${name}`);
      const hash = createHash('sha256').update(worker(assets, ''));
      for (const file of files) hash.update(readFileSync(resolve(`public${file}`)));
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: worker(assets, hash.digest('hex').slice(0, 16)),
      });
    },
  };
}
