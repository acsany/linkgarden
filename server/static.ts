import { resolve } from 'node:path';
import express, { type Express } from 'express';

export function mountBuiltFiles(app: Express) {
  app.use('/assets', express.static(resolve('dist/assets'), { immutable: true, maxAge: '1y' }));
  app.use('/icons', express.static(resolve('dist/icons'), { maxAge: '1d' }));
  for (const file of ['sw.js', 'manifest.webmanifest', 'offline.html']) {
    app.get(`/${file}`, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      if (file === 'sw.js') res.setHeader('Service-Worker-Allowed', '/');
      res.sendFile(resolve('dist', file));
    });
  }
}
