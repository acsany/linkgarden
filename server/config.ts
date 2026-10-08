import 'dotenv/config';
export interface Config {
  production: boolean;
  port: number;
  host: string;
  origin: string;
  databaseUrl?: string;
  dataDir: string;
  filesDir: string;
  maxUploadBytes: number;
  pgSsl: boolean;
  adminEmail?: string;
  adminPasswordHash?: string;
}
export function getConfig(): Config {
  const production = process.env.NODE_ENV === 'production';
  const port = Number(process.env.PORT || 3000);
  const origin =
    process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
  const url = new URL(origin);
  const dataDir = process.env.DATA_DIR || '.data';
  if (production && (url.protocol !== 'https:' || !process.env.DATABASE_URL)) {
    throw new Error(
      'Production requires an HTTPS APP_ORIGIN (or RENDER_EXTERNAL_URL) and DATABASE_URL.',
    );
  }
  // Render's filesystem is replaced on every deploy; uploads need the mounted disk.
  if (production && !process.env.FILES_DIR)
    throw new Error('Production requires FILES_DIR on a persistent disk for uploaded PDFs.');
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Error('APP_ORIGIN must be a plain origin.');
  return {
    production,
    port,
    origin: url.origin,
    host: process.env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
    databaseUrl: process.env.DATABASE_URL,
    dataDir,
    filesDir: process.env.FILES_DIR || `${dataDir}-files`,
    maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024,
    pgSsl: process.env.PG_SSL === 'true',
    adminEmail: process.env.ADMIN_EMAIL,
    adminPasswordHash: process.env.ADMIN_PASSWORD_HASH,
  };
}
