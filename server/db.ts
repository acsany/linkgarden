import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { mkdir } from 'node:fs/promises';
import type { Config } from './config.js';
export interface Queryable {
  query(sql: string, params?: any[]): Promise<{ rows: Record<string, any>[] }>;
}
export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function openDb(
  config: Pick<Config, 'databaseUrl' | 'dataDir' | 'pgSsl'>,
): Promise<Database> {
  if (config.databaseUrl) {
    const pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 5,
      ...(config.pgSsl ? { ssl: { rejectUnauthorized: true } } : {}),
    });
    return {
      query: (sql, params) => pool.query(sql, params),
      close: () => pool.end(),
      async transaction(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const out = await fn(client);
          await client.query('COMMIT');
          return out;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      },
    };
  }
  if (config.dataDir !== ':memory:') await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const db = new PGlite(config.dataDir === ':memory:' ? undefined : config.dataDir);
  await db.waitReady;
  return {
    query: (sql, params) => db.query(sql, params),
    transaction: (fn) => db.transaction((tx) => fn(tx)),
    close: () => db.close(),
  };
}
export async function migrate(db: Database) {
  await db.transaction(async (tx) => {
    await tx.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY)`);
    // Serializes migration runners on PostgreSQL and works with embedded PostgreSQL.
    await tx.query('LOCK TABLE schema_migrations IN EXCLUSIVE MODE');
    const done = new Set(
      (await tx.query('SELECT version FROM schema_migrations')).rows.map((r) => Number(r.version)),
    );
    if (!done.has(1)) await version1(tx);
    if (!done.has(2))
      for (const sql of [
        // Theme ids are validated by shared/themes.ts so new themes need no migration.
        `ALTER TABLE sites ADD COLUMN theme text NOT NULL DEFAULT 'default'`,
        `INSERT INTO schema_migrations(version) VALUES(2)`,
      ])
        await tx.query(sql);
    if (!done.has(3))
      for (const sql of [
        // Sections share the ordered links list; they have no URL and are never clicked.
        `ALTER TABLE links ADD COLUMN kind text NOT NULL DEFAULT 'link' CHECK (kind IN ('link','section'))`,
        `INSERT INTO schema_migrations(version) VALUES(3)`,
      ])
        await tx.query(sql);
    if (!done.has(4))
      for (const sql of [
        // Uploaded PDFs live on disk at <FILES_DIR>/<id>/<filename>; rows hold their metadata.
        `CREATE TABLE files (id uuid PRIMARY KEY, filename text NOT NULL, size bigint NOT NULL, sha256 text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
        `ALTER TABLE links ADD COLUMN file_id uuid REFERENCES files(id)`,
        `CREATE INDEX links_file ON links(file_id)`,
        `ALTER TABLE links DROP CONSTRAINT links_kind_check`,
        `ALTER TABLE links ADD CONSTRAINT links_kind_check CHECK (kind IN ('link','section','file'))`,
        `ALTER TABLE links ADD CONSTRAINT links_file_check CHECK ((kind='file') = (file_id IS NOT NULL))`,
        `INSERT INTO schema_migrations(version) VALUES(4)`,
      ])
        await tx.query(sql);
    if (!done.has(5))
      for (const sql of [
        // Campaigns attribute traffic per recipient through /<slug>/<code> URLs.
        `CREATE TABLE campaigns (id uuid PRIMARY KEY, code text COLLATE "C" UNIQUE NOT NULL, name text NOT NULL, note text NOT NULL DEFAULT '', status text NOT NULL CHECK (status IN ('active','inactive','archived')), visits bigint NOT NULL DEFAULT 0, clicks bigint NOT NULL DEFAULT 0, last_visit_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
        // Removing an assignment only sets removed_at, so its counters survive and return on reassignment.
        `CREATE TABLE site_campaigns (site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE, campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, visits bigint NOT NULL DEFAULT 0, clicks bigint NOT NULL DEFAULT 0, last_visit_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz, PRIMARY KEY(site_id,campaign_id))`,
        `CREATE INDEX site_campaigns_campaign ON site_campaigns(campaign_id)`,
        `ALTER TABLE sites ADD COLUMN campaign_only boolean NOT NULL DEFAULT false`,
        `ALTER TABLE events ADD COLUMN campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL`,
        `CREATE INDEX events_campaign_time ON events(campaign_id,occurred_at DESC) WHERE campaign_id IS NOT NULL`,
        // Kept apart from daily_metrics, which stays the page total including campaign traffic.
        `CREATE TABLE campaign_daily_metrics (site_id uuid NOT NULL, campaign_id uuid NOT NULL, day date NOT NULL, visits bigint NOT NULL DEFAULT 0, clicks bigint NOT NULL DEFAULT 0, PRIMARY KEY(site_id,campaign_id,day), FOREIGN KEY(site_id,campaign_id) REFERENCES site_campaigns(site_id,campaign_id) ON DELETE CASCADE)`,
        `CREATE INDEX campaign_daily_metrics_campaign ON campaign_daily_metrics(campaign_id,day)`,
        `CREATE TABLE campaign_link_clicks (link_id uuid NOT NULL REFERENCES links(id) ON DELETE CASCADE, campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, clicks bigint NOT NULL DEFAULT 0, PRIMARY KEY(link_id,campaign_id))`,
        `INSERT INTO schema_migrations(version) VALUES(5)`,
      ])
        await tx.query(sql);
    if (!done.has(6))
      for (const sql of [
        // A manual icon per link ('' = automatic) and ordered URL-pattern rules for the rest.
        `ALTER TABLE links ADD COLUMN icon text NOT NULL DEFAULT ''`,
        `CREATE TABLE icon_rules (id uuid PRIMARY KEY, pattern text NOT NULL, icon text NOT NULL, position integer NOT NULL)`,
        `INSERT INTO icon_rules(id,pattern,icon,position) VALUES
          ('5b0f6c38-6f0e-4a59-9a43-1c1f2b6f0a01','realpython.com/courses/*','circle-play',0),
          ('5b0f6c38-6f0e-4a59-9a43-1c1f2b6f0a02','realpython.com/podcasts/*','podcast',1),
          ('5b0f6c38-6f0e-4a59-9a43-1c1f2b6f0a03','realpython.com/team/*','user',2),
          ('5b0f6c38-6f0e-4a59-9a43-1c1f2b6f0a05','realpython.com/python-news-*','newspaper',3),
          ('5b0f6c38-6f0e-4a59-9a43-1c1f2b6f0a04','realpython.com/*','file-lines',4)`,
        `INSERT INTO schema_migrations(version) VALUES(6)`,
      ])
        await tx.query(sql);
    if (!done.has(7)) {
      await tx.query("UPDATE sites SET theme='cv' WHERE theme='cv-sans'");
      await tx.query('INSERT INTO schema_migrations(version) VALUES(7)');
    }
    if (!done.has(8)) {
      await tx.query(
        `CREATE TABLE preview_images (id text PRIMARY KEY, bytes bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
      );
      await tx.query(
        `CREATE TABLE preview_sources (url text PRIMARY KEY, image_id text NOT NULL REFERENCES preview_images(id), created_at timestamptz NOT NULL DEFAULT now())`,
      );
      await tx.query(
        `CREATE TABLE preview_cache (url text PRIMARY KEY, title text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '', image_id text NOT NULL REFERENCES preview_images(id), updated_at timestamptz NOT NULL DEFAULT now())`,
      );
      await tx.query('INSERT INTO schema_migrations(version) VALUES(8)');
    }
    if (!done.has(9)) {
      // Link cards show the whole URL unless a link asks for just its domain.
      await tx.query('ALTER TABLE links ADD COLUMN full_url boolean NOT NULL DEFAULT true');
      await tx.query('INSERT INTO schema_migrations(version) VALUES(9)');
    }
    if (!done.has(10)) {
      // Markdown fetches (/<slug>.md) are visits too; this keeps the agent share apart.
      await tx.query('ALTER TABLE sites ADD COLUMN agent_visits bigint NOT NULL DEFAULT 0');
      await tx.query('INSERT INTO schema_migrations(version) VALUES(10)');
    }
    if (!done.has(11)) {
      // Set when the admin resets a page's analytics; counting restarts at that time.
      await tx.query('ALTER TABLE sites ADD COLUMN stats_reset_at timestamptz');
      await tx.query('INSERT INTO schema_migrations(version) VALUES(11)');
    }
  });
}
async function version1(tx: Queryable) {
  const statements = [
    `CREATE TABLE admin (id integer PRIMARY KEY CHECK (id=1), email text NOT NULL, password_hash text NOT NULL)`,
    `CREATE TABLE sessions (token_hash text PRIMARY KEY, csrf_token text NOT NULL, expires_at timestamptz NOT NULL)`,
    `CREATE TABLE sites (id uuid PRIMARY KEY, slug text COLLATE "C" UNIQUE NOT NULL, title text NOT NULL, description text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '', mode text NOT NULL CHECK (mode IN ('redirect','aggregate')), status text NOT NULL CHECK (status IN ('active','inactive','archived')), visits bigint NOT NULL DEFAULT 0, clicks bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE links (id uuid PRIMARY KEY, site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE, url text NOT NULL, title text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '', image_url text NOT NULL DEFAULT '', embed boolean NOT NULL DEFAULT false, position integer NOT NULL, clicks bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE INDEX links_site_position ON links(site_id,position)`,
    `CREATE TABLE events (id uuid PRIMARY KEY, site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE, link_id uuid REFERENCES links(id) ON DELETE SET NULL, kind text NOT NULL CHECK (kind IN ('visit','click')), target text NOT NULL DEFAULT '', referrer text NOT NULL DEFAULT '', occurred_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE INDEX events_site_time ON events(site_id,occurred_at DESC)`,
    `CREATE INDEX events_time ON events(occurred_at)`,
    `CREATE TABLE daily_metrics (site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE, day date NOT NULL, visits bigint NOT NULL DEFAULT 0, clicks bigint NOT NULL DEFAULT 0, PRIMARY KEY(site_id,day))`,
    `CREATE TABLE agent_tokens (id uuid PRIMARY KEY, name text NOT NULL, token_hash text UNIQUE NOT NULL, scope text NOT NULL CHECK (scope IN ('read','write')), expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz)`,
    `INSERT INTO schema_migrations(version) VALUES(1)`,
  ];
  for (const sql of statements) await tx.query(sql);
}
