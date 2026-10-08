import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openDb, migrate, type Database } from '../server/db.js';
import { createApp, csvCell } from '../server/app.js';
import { hashPassword, seedAdmin, createAgentToken, digest, login } from '../server/auth.js';
import type { Config } from '../server/config.js';
import { siteSchema } from '../shared/schemas.js';
import { videoInfo } from '../shared/video.js';
import sharp from 'sharp';
import { fetchImage } from '../server/metadata.js';
import { randomSlug } from '../server/random.js';
vi.mock('../server/metadata.js', () => ({
  fetchImage: vi.fn(async () => {
    throw new Error('Image fetching is disabled in tests.');
  }),
  fetchMetadata: vi.fn(async (url: string) => ({
    title: 'Fetched title',
    description: 'Fetched description',
    imageUrl: 'https://example.com/image.jpg',
    embedUrl: null,
    warning: '',
  })),
}));
let db: Database;
let built: ReturnType<typeof createApp>;
let listener: Server;
const config: Config = {
  production: false,
  host: '127.0.0.1',
  port: 3000,
  origin: 'http://localhost:3000',
  dataDir: ':memory:',
  filesDir: '',
  maxUploadBytes: 64 * 1024,
  databaseUrl: process.env.TEST_DATABASE_URL,
  pgSsl: false,
  adminEmail: 'owner@example.com',
};
const input = (overrides: Record<string, any> = {}) =>
  siteSchema.parse({
    title: 'Test page',
    slug: 'Ab3xY',
    mode: 'aggregate',
    note: 'Secret campaign note',
    links: [
      {
        url: 'https://example.com/path',
        title: 'Example',
        imageUrl: 'https://example.com/image.jpg',
      },
    ],
    ...overrides,
  });
const browser = (r: request.Test) =>
  r.set('Origin', config.origin).set('User-Agent', 'Mozilla/5.0');
async function signedIn() {
  const a = request.agent(built.app);
  const result = await browser(a.post('/api/auth/login')).send({
    email: 'owner@example.com',
    password: 'correct-password-123',
  });
  expect(result.status).toBe(200);
  return { a, csrf: result.body.csrfToken };
}
beforeAll(async () => {
  config.filesDir = await mkdtemp(join(tmpdir(), 'linkgarden-files-'));
  db = await openDb(config);
  await migrate(db);
  config.adminPasswordHash = await hashPassword('correct-password-123');
  await seedAdmin(db, config);
  built = createApp(db, config);
  built.finish();
  listener = built.app.listen(0, '127.0.0.1');
});
beforeEach(async () => {
  await db.query(
    'TRUNCATE sites,campaigns,sessions,agent_tokens,files,icon_rules,preview_cache,preview_sources,preview_images CASCADE',
  );
  built.service.previews.failedSources.clear();
  built.service.previews.failedTargets.clear();
  vi.mocked(fetchImage).mockReset();
  vi.mocked(fetchImage).mockRejectedValue(new Error('Image fetching is disabled in tests.'));
});
afterAll(async () => {
  await new Promise<void>((r) => listener.close(() => r()));
  await Promise.all([built.readMcp.close(), built.writeMcp.close()]);
  await db.close();
  await rm(config.filesDir, { recursive: true, force: true });
});
describe('authentication boundaries', () => {
  it('requires login, configured origin, and a session CSRF token', async () => {
    expect((await request(built.app).get('/api/admin/sites')).status).toBe(401);
    expect(
      (
        await request(built.app)
          .post('/api/auth/login')
          .send({ email: 'owner@example.com', password: 'correct-password-123' })
      ).status,
    ).toBe(403);
    expect(
      (
        await browser(request(built.app).post('/api/auth/login')).send({
          email: 'other@example.com',
          password: 'correct-password-123',
        })
      ).status,
    ).toBe(401);
    const { a, csrf } = await signedIn();
    expect((await browser(a.post('/api/admin/sites')).send(input())).status).toBe(403);
    const saved = await browser(a.post('/api/admin/sites')).set('X-CSRF-Token', csrf).send(input());
    expect(saved.status).toBe(201);
    expect((await a.get('/api/admin/sites')).body).toHaveLength(1);
    expect((await a.get('/api/admin/sites').set('Origin', 'https://evil.example')).status).toBe(
      403,
    );
    expect((await a.get('/api/admin/sites').set('Host', 'evil.example')).status).toBe(403);
    await browser(a.post('/api/auth/logout')).set('X-CSRF-Token', csrf).send({});
    expect((await a.get('/api/admin/sites')).status).toBe(401);
  });
  it('does not count successful sign-ins toward the login limit', async () => {
    for (let i = 0; i < 11; i++) await signedIn();
    const { a } = await signedIn();
    expect((await a.get('/api/auth/session')).body.authenticated).toBe(true);
  });
  it('hashes passwords and revokes sessions when admin configuration changes', async () => {
    const { a } = await signedIn();
    expect((await a.get('/api/auth/session')).body.authenticated).toBe(true);
    await seedAdmin(db, {
      ...config,
      adminPasswordHash: await hashPassword('correct-password-123'),
    });
    expect((await a.get('/api/auth/session')).body.authenticated).toBe(false);
  });
});
describe('page lifecycle and analytics', () => {
  it('serves a static landing page at the root instead of the admin app', async () => {
    const root = await request(built.app).get('/');
    expect(root.status).toBe(200);
    expect(root.text).toContain("<h1>Linkgarden</h1>");
    expect(root.text).not.toContain('<script');
  });
  it('keeps every public response out of search engines while letting crawlers see that', async () => {
    const s = await built.service.create(input());
    const ua = 'Mozilla/5.0 (compatible; Googlebot/2.1)';
    const robots = await request(built.app).get('/robots.txt');
    expect(robots.text).not.toContain('/r/');
    expect(robots.text).toContain('Disallow: /admin');
    for (const path of ['/', '/Ab3xY', '/r/' + s.links[0].id, '/missing-page', '/robots.txt']) {
      const r = await request(built.app).get(path).set('User-Agent', ua);
      expect(r.headers['x-robots-tag'], path).toBe('noindex, nofollow, noarchive');
    }
    expect((await request(built.app).get('/')).text).toContain('<meta name="robots"');
    expect((await request(built.app).get('/Ab3xY')).text).toContain('<meta name="robots"');
    expect((await request(built.app).get('/missing-page')).text).toContain('<meta name="robots"');
  });
  it('uses case-sensitive slugs and never leaks private notes or metrics', async () => {
    const s = await built.service.create(input());
    const publicResult = await request(built.app).get('/api/public/sites/Ab3xY');
    expect(publicResult.status).toBe(200);
    expect(publicResult.body).not.toHaveProperty('note');
    expect(publicResult.body).not.toHaveProperty('visits');
    expect(publicResult.body.links[0]).not.toHaveProperty('clicks');
    expect((await request(built.app).get('/ab3xy')).status).toBe(404);
    const other = await built.service.create(input({ slug: 'ab3xy' }));
    expect(other.slug).toBe('ab3xy');
    expect(s.slug).toBe('Ab3xY');
  });
  it('generates exactly five alphanumeric characters and rejects duplicate, reserved, and unsafe inputs', async () => {
    const s = await built.service.create(input({ slug: undefined }));
    expect(s.slug).toMatch(/^[A-Za-z0-9]{5}$/);
    await expect(built.service.create(input({ slug: s.slug }))).rejects.toMatchObject({
      status: 409,
    });
    expect(() => input({ slug: 'ADMIN' })).toThrow();
    expect(() => input({ slug: 'icons' })).toThrow();
    expect(() => input({ links: [{ url: 'javascript:alert(1)' }] })).toThrow();
    expect(() => input({ links: [{ url: 'https://user:pass@example.com/' }] })).toThrow();
  });
  it('counts real page loads and outbound clicks, excludes bots and HEAD, and stores UTC time without IPs', async () => {
    const s = await built.service.create(input());
    const id = s.links[0].id!;
    expect(
      (
        await request(built.app)
          .get('/Ab3xY')
          .set('User-Agent', 'Mozilla/5.0')
          .set('Referer', 'https://source.example/path?private=secret')
      ).status,
    ).toBe(200);
    await request(built.app).get('/Ab3xY').set('User-Agent', 'Googlebot');
    await request(built.app).head('/Ab3xY').set('User-Agent', 'Mozilla/5.0');
    const click = await request(built.app)
      .get('/r/' + id)
      .set('User-Agent', 'Mozilla/5.0');
    expect(click.status).toBe(302);
    expect(click.headers.location).toBe('https://example.com/path');
    const a = await built.service.analytics(s.id);
    expect(a.site.visits).toBe(1);
    expect(a.site.clicks).toBe(1);
    expect(a.site.links[0].clicks).toBe(1);
    expect(a.daily[0]).toMatchObject({ visits: 1, clicks: 1 });
    expect(a.events).toHaveLength(2);
    expect(a.events.find((e) => e.kind === 'visit')?.referrer).toBe('https://source.example');
    const event = (await db.query('SELECT * FROM events LIMIT 1')).rows[0];
    expect(event).not.toHaveProperty('ip');
    expect(event.occurred_at).toBeInstanceOf(Date);
  });
  it('counts one visit and one click for direct redirects and validates single destinations', async () => {
    const s = await built.service.create(input({ mode: 'redirect' }));
    const result = await request(built.app).get('/Ab3xY').set('User-Agent', 'Mozilla/5.0');
    expect(result.status).toBe(302);
    const updated = await built.service.get(s.id);
    expect(updated.visits).toBe(1);
    expect(updated.clicks).toBe(1);
    expect(updated.links[0].clicks).toBe(1);
    expect(() =>
      input({
        mode: 'redirect',
        links: [{ url: 'https://example.com' }, { url: 'https://example.org' }],
      }),
    ).toThrow();
  });
  it('stores page themes, exposes them publicly, and carries them into duplicates', async () => {
    const s = await built.service.create(input());
    expect(s.theme).toBe('default');
    expect(() => input({ theme: 'neon' })).toThrow();
    const themed = await built.service.update(s.id, { ...s, theme: 'cv' });
    expect(themed.theme).toBe('cv');
    const pub = await request(built.app).get('/api/public/sites/Ab3xY');
    expect(pub.body.theme).toBe('cv');
    const html = await request(built.app).get('/Ab3xY').set('User-Agent', 'Mozilla/5.0');
    expect(html.text).toContain('<body data-theme="cv">');
    expect((await built.service.duplicate(s.id)).theme).toBe('cv');
  });
  it('orders sections with links, keeps their IDs on reorder, and never treats them as links', async () => {
    const section = { kind: 'section', title: 'Talks', description: 'Recorded meetups' };
    const s = await built.service.create(
      input({ links: [section, ...input().links, { kind: 'section', title: 'Elsewhere' }] }),
    );
    expect(s.links.map((l) => l.kind)).toEqual(['section', 'link', 'section']);
    expect(s.links[0]).toMatchObject({ title: 'Talks', description: 'Recorded meetups', url: '' });
    const [head, link, tail] = s.links;
    const moved = await built.service.update(s.id, { ...s, links: [link, tail, head] });
    expect(moved.links.map((l) => l.id)).toEqual([link.id, tail.id, head.id]);
    expect((await built.service.list()).find((x) => x.id === s.id)?.linkCount).toBe(1);
    const pub = await request(built.app).get('/api/public/sites/Ab3xY');
    expect(pub.body.links[2]).toMatchObject({ kind: 'section', title: 'Talks' });
    expect(pub.body.links[2]).not.toHaveProperty('clicks');
    const click = await request(built.app)
      .get('/r/' + head.id)
      .set('User-Agent', 'Mozilla/5.0');
    expect(click.status).toBe(404);
    await expect(built.service.record(s.id, 'click', head.id!, 'outbound', '')).rejects.toThrow(
      'Link not found.',
    );
    expect(() => input({ links: [section] })).toThrow('Add at least one link or PDF.');
    expect(() => input({ links: [{ kind: 'section', title: ' ' }, ...input().links] })).toThrow();
    expect(() =>
      input({ links: [{ ...section, url: 'https://example.com' }, ...input().links] }),
    ).toThrow();
    expect(() => input({ mode: 'redirect', links: [section] })).toThrow();
    expect(() =>
      input({ mode: 'redirect', links: [section, { url: 'https://example.com' }] }),
    ).toThrow('Redirects require exactly one destination.');
  });
  it('overwrites slugs while preserving counters and duplicates with fresh metrics and new link IDs', async () => {
    const s = await built.service.create(input());
    await built.service.record(s.id, 'visit', null, 'page', '');
    await built.service.record(s.id, 'click', s.links[0].id!, 'outbound', '');
    const changed = await built.service.update(s.id, { ...s, slug: 'NewUrl' });
    expect(changed.visits).toBe(1);
    expect(changed.links[0].clicks).toBe(1);
    expect((await request(built.app).get('/Ab3xY')).status).toBe(404);
    const clone = await built.service.duplicate(s.id);
    expect(clone.slug).toMatch(/^[A-Za-z0-9]{5}$/);
    expect(clone.status).toBe('inactive');
    expect(clone.note).toBe(s.note);
    expect(clone.visits).toBe(0);
    expect(clone.clicks).toBe(0);
    expect(clone.links[0].clicks).toBe(0);
    expect(clone.links[0].id).not.toBe(s.links[0].id);
    expect((await built.service.analytics(clone.id)).events).toHaveLength(0);
  });
  it('disables pages and links when inactive or archived, then restores them', async () => {
    const s = await built.service.create(input());
    for (const status of ['inactive', 'archived'] as const) {
      await built.service.setState(s.id, status);
      expect((await request(built.app).get('/Ab3xY')).status).toBe(404);
      expect((await request(built.app).get('/api/public/sites/Ab3xY')).status).toBe(404);
      expect((await request(built.app).get('/r/' + s.links[0].id)).status).toBe(404);
    }
    await built.service.setState(s.id, 'active');
    expect((await request(built.app).get('/Ab3xY').set('User-Agent', 'Googlebot')).status).toBe(
      200,
    );
  });
  it("never counts the signed-in admin's own visits and clicks", async () => {
    const s = await built.service.create(
      input({ links: [{ url: 'https://youtu.be/dQw4w9WgXcQ', embed: true }] }),
    );
    const id = s.links[0].id!;
    const { a } = await signedIn();
    expect((await browser(a.get('/Ab3xY'))).status).toBe(200);
    expect((await browser(a.get('/Ab3xY.md'))).status).toBe(200);
    expect((await browser(a.get('/r/' + id))).status).toBe(302);
    expect((await browser(a.post('/api/public/links/' + id + '/embed')).send({})).status).toBe(200);
    expect((await built.service.analytics(s.id)).events).toHaveLength(0);
    // A stale cookie is an ordinary visitor.
    await browser(request(built.app).get('/Ab3xY')).set('Cookie', 'lg_session=expired');
    const site = await built.service.get(s.id);
    expect(site).toMatchObject({ visits: 1, clicks: 0, agentVisits: 0 });
  });
  it('shows inactive and archived pages only to the signed-in admin, with their status', async () => {
    const s = await built.service.create(input());
    const { a } = await signedIn();
    expect((await a.get('/api/public/sites/Ab3xY')).body).not.toHaveProperty('status');
    for (const status of ['inactive', 'archived'] as const) {
      await built.service.setState(s.id, status);
      expect((await browser(request(built.app).get('/Ab3xY'))).status).toBe(404);
      expect((await browser(a.get('/Ab3xY'))).status).toBe(200);
      const json = await a.get('/api/public/sites/Ab3xY');
      expect(json.body).toMatchObject({ slug: 'Ab3xY', status });
      expect(json.body).not.toHaveProperty('note');
      expect(json.headers['cache-control']).toBe('no-store');
      expect((await browser(a.get('/r/' + s.links[0].id))).status).toBe(302);
    }
    expect((await built.service.get(s.id)).visits).toBe(0);
  });
  it('resets a page’s analytics, including its share of campaign totals', async () => {
    const s = await built.service.create(input({ slug: 'cv' }));
    const other = await built.service.create(input({ slug: 'other' }));
    const c = await built.service.campaigns.create({
      name: 'Example Company',
      code: 'acme',
      note: '',
      status: 'active',
      sites: ['cv', 'other'],
    });
    const human = (path: string) => browser(request(built.app).get(path));
    await human('/cv');
    await human('/cv/acme');
    await human('/cv.md');
    await human('/r/' + s.links[0].id + '?c=acme');
    await human('/other/acme');
    expect(await built.service.campaigns.get(c.id)).toMatchObject({ visits: 2, clicks: 1 });
    const { a, csrf } = await signedIn();
    const reset = await browser(a.post('/api/admin/sites/' + s.id + '/reset-stats'))
      .set('X-CSRF-Token', csrf)
      .send({});
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ visits: 0, clicks: 0, agentVisits: 0 });
    expect(reset.body.links[0].clicks).toBe(0);
    expect(reset.body.statsResetAt).toBeTruthy();
    const after = await built.service.analytics(s.id);
    expect(after.events).toHaveLength(0);
    expect(after.daily).toHaveLength(0);
    expect(after.agentVisits).toBe(0);
    expect(after.campaigns[0]).toMatchObject({ visits: 0, clicks: 0, lastVisitAt: null });
    expect(after.unattributed).toMatchObject({ visits: 0, clicks: 0, lastVisitAt: null });
    // The other page keeps its traffic, and the campaign keeps that share.
    expect(await built.service.campaigns.get(c.id)).toMatchObject({ visits: 1, clicks: 0 });
    expect((await built.service.campaigns.get(c.id)).lastVisitAt).toBeTruthy();
    expect((await built.service.get(other.id)).visits).toBe(1);
    expect((await built.service.campaigns.analytics(c.id)).events).toHaveLength(1);
    // Counting goes on as before.
    await human('/cv/acme');
    expect((await built.service.get(s.id)).visits).toBe(1);
    expect((await a.post('/api/admin/sites/' + s.id + '/reset-stats').send({})).status).toBe(403);
  });
  it('prevents link ID injection and preserves removed link history', async () => {
    const one = await built.service.create(input());
    const two = await built.service.create(input({ slug: 'Other' }));
    await expect(built.service.update(one.id, { ...one, links: two.links })).rejects.toMatchObject({
      status: 400,
    });
    await built.service.record(one.id, 'click', one.links[0].id!, 'outbound', '');
    const updated = await built.service.update(one.id, { ...one, links: input().links });
    expect(updated.clicks).toBe(1);
    expect((await built.service.analytics(one.id)).events[0].linkId).toBeNull();
  });
  it('only allows approved embeds and counts explicit video load clicks', async () => {
    const s = await built.service.create(
      input({
        links: [
          {
            url: 'https://youtu.be/dQw4w9WgXcQ',
            embed: true,
            title: 'Video',
            imageUrl: 'https://i.ytimg.com/test.jpg',
          },
        ],
      }),
    );
    const r = await browser(
      request(built.app).post('/api/public/links/' + s.links[0].id + '/embed'),
    ).send({});
    expect(r.status).toBe(200);
    expect((await built.service.get(s.id)).clicks).toBe(1);
    await expect(
      built.service.create(
        input({ slug: 'Invalid', links: [{ url: 'https://example.com', embed: true }] }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(videoInfo('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(videoInfo('https://vimeo.com/123456/abcdef')?.embedUrl).toContain('?h=abcdef');
  });
  it('expires detailed events while keeping lifetime counters and daily metrics', async () => {
    const s = await built.service.create(input());
    await built.service.record(s.id, 'visit', null, 'page', '');
    await db.query("UPDATE events SET occurred_at=now()-interval '366 days'");
    await built.service.cleanup();
    expect((await db.query('SELECT * FROM events')).rows).toHaveLength(0);
    expect((await built.service.get(s.id)).visits).toBe(1);
    expect((await built.service.analytics(s.id)).daily[0].visits).toBe(1);
  });
  it('exports authenticated timestamped CSV and protects spreadsheet cells', async () => {
    const s = await built.service.create(input());
    await built.service.record(
      s.id,
      'click',
      s.links[0].id!,
      'outbound',
      'https://example.org/path?secret=x',
    );
    expect((await request(built.app).get('/api/admin/sites/' + s.id + '/events.csv')).status).toBe(
      401,
    );
    const { a } = await signedIn();
    const csv = await a.get('/api/admin/sites/' + s.id + '/events.csv');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('timestamp_utc');
    expect(csv.text).toContain('https://example.org');
    expect(csv.text).not.toContain('secret=x');
    expect(csvCell(' =HYPERLINK("evil")')).toContain("' =HYPERLINK");
  });
});
describe('PDF uploads', () => {
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
  // Sessions come from the service directly so these tests stay under the login rate limit.
  async function upload(name: string, body: Buffer = pdf) {
    const s = await login(db, 'owner@example.com', 'correct-password-123');
    return browser(request(built.app).post('/api/admin/files'))
      .set('Cookie', 'lg_session=' + s.token)
      .set('X-CSRF-Token', s.csrfToken)
      .set('Content-Type', 'application/pdf')
      .set('X-Filename', encodeURIComponent(name))
      .send(body);
  }
  const fileItem = (fileId: string, extra: Record<string, any> = {}) => ({
    kind: 'file',
    fileId,
    ...extra,
  });
  it('requires a session and CSRF token, accepts only bounded PDFs, and keeps safe names', async () => {
    const anonymous = await browser(request(built.app).post('/api/admin/files'))
      .set('Content-Type', 'application/pdf')
      .send(pdf);
    expect(anonymous.status).toBe(401);
    const s = await login(db, 'owner@example.com', 'correct-password-123');
    const noCsrf = await browser(request(built.app).post('/api/admin/files'))
      .set('Cookie', 'lg_session=' + s.token)
      .set('Content-Type', 'application/pdf')
      .send(pdf);
    expect(noCsrf.status).toBe(403);
    expect((await upload('fake.pdf', Buffer.from('<html>not a pdf</html>'))).status).toBe(400);
    expect((await upload('big.pdf', Buffer.concat([pdf, Buffer.alloc(70 * 1024)]))).status).toBe(
      413,
    );
    const ok = await upload('Bericht über 2026.pdf');
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ filename: 'Bericht über 2026.pdf', size: pdf.length });
    expect(await readFile(join(config.filesDir, ok.body.id, 'Bericht über 2026.pdf'))).toEqual(pdf);
    const sneaky = await upload('../../evil\u202efdp.exe');
    expect(sneaky.body.filename).toBe('evilfdp.exe.pdf');
    expect(existsSync(join(config.filesDir, sneaky.body.id, 'evilfdp.exe.pdf'))).toBe(true);
    expect((await upload('...')).body.filename).toBe('document.pdf');
  });
  it('downloads under the original name through tracked links without exposing storage', async () => {
    const f = (await upload('Bericht über 2026.pdf')).body;
    const s = await built.service.create(
      input({ links: [...input().links, fileItem(f.id, { description: 'Annual report' })] }),
    );
    const item = s.links[1];
    expect(item).toMatchObject({ kind: 'file', fileId: f.id, url: '', imageUrl: '' });
    expect(item.file).toEqual({ filename: 'Bericht über 2026.pdf', size: pdf.length });
    expect((await built.service.list())[0].linkCount).toBe(2);
    const pub = await request(built.app).get('/api/public/sites/Ab3xY');
    expect(pub.body.links[1]).toMatchObject({ kind: 'file', file: item.file });
    expect(pub.body.links[1]).not.toHaveProperty('fileId');
    expect(JSON.stringify(pub.body)).not.toContain(config.filesDir);
    const download = await request(built.app)
      .get('/r/' + item.id)
      .set('User-Agent', 'Mozilla/5.0')
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(download.status).toBe(200);
    expect(download.body).toEqual(pdf);
    expect(download.headers['content-type']).toBe('application/pdf');
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.headers['content-disposition']).toContain(
      "filename*=UTF-8''Bericht%20%C3%BCber%202026.pdf",
    );
    expect(download.headers['content-security-policy']).toBe('sandbox');
    expect(download.headers['cache-control']).toBe('no-store');
    const a = await built.service.analytics(s.id);
    expect(a.site.links[1].clicks).toBe(1);
    expect(a.events[0]).toMatchObject({ kind: 'click', target: 'download' });
    expect((await request(built.app).get('/api/admin/files/' + f.id)).status).toBe(401);
    await built.service.setState(s.id, 'inactive');
    expect((await request(built.app).get('/r/' + item.id)).status).toBe(404);
  });
  it('serves a PDF directly from a redirect page and validates file items', async () => {
    const f = (await upload('Flyer.pdf')).body;
    const s = await built.service.create(input({ mode: 'redirect', links: [fileItem(f.id)] }));
    const r = await request(built.app).get('/Ab3xY').set('User-Agent', 'Mozilla/5.0');
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toContain('filename="Flyer.pdf"');
    const updated = await built.service.get(s.id);
    expect(updated).toMatchObject({ visits: 1, clicks: 1 });
    expect(() => input({ links: [{ kind: 'file' }] })).toThrow('Upload a PDF file.');
    expect(() => input({ links: [fileItem(f.id, { url: 'https://example.com' })] })).toThrow();
    expect(() => input({ links: [{ url: 'https://example.com', fileId: f.id }] })).toThrow(
      'Only PDF items have a file.',
    );
    await expect(
      built.service.create(
        input({ slug: 'Gone1', links: [fileItem('00000000-0000-4000-8000-000000000000')] }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('keeps item IDs on update, shares files with duplicates, and removes only orphaned files', async () => {
    const kept = (await upload('Kept.pdf')).body;
    const orphan = (await upload('Orphan.pdf')).body;
    const s = await built.service.create(input({ links: [fileItem(kept.id)] }));
    await built.service.record(s.id, 'click', s.links[0].id!, 'download', '');
    const renamed = await built.service.update(s.id, {
      ...s,
      links: [{ ...s.links[0], title: 'Our flyer' }],
    });
    expect(renamed.links[0]).toMatchObject({ id: s.links[0].id, clicks: 1, title: 'Our flyer' });
    const clone = await built.service.duplicate(s.id);
    expect(clone.links[0].fileId).toBe(kept.id);
    await built.service.cleanup();
    expect(existsSync(join(config.filesDir, orphan.id))).toBe(true);
    await db.query("UPDATE files SET created_at=now()-interval '2 days'");
    await built.service.cleanup();
    expect(existsSync(join(config.filesDir, orphan.id))).toBe(false);
    expect(existsSync(join(config.filesDir, kept.id, 'Kept.pdf'))).toBe(true);
    expect((await db.query('SELECT id FROM files')).rows.map((r) => r.id)).toEqual([kept.id]);
  });
});
describe('campaigns', () => {
  const human = (r: request.Test) => r.set('User-Agent', 'Mozilla/5.0');
  const status = async (path: string) => (await human(request(built.app).get(path))).status;
  async function setup(overrides: Record<string, any> = {}) {
    const s = await built.service.create(input({ slug: 'cv', ...overrides }));
    const c = await built.service.campaigns.create({
      name: 'Example Company',
      code: 'acme',
      note: 'Applied for the senior role',
      status: 'active',
      sites: ['cv'],
    });
    return { s, c };
  }
  // Counters as numbers: pg returns bigint as text, PGlite as a number.
  async function pair(siteId: string, campaignId: string) {
    const r = (
      await db.query(
        'SELECT visits,clicks FROM site_campaigns WHERE site_id=$1 AND campaign_id=$2',
        [siteId, campaignId],
      )
    ).rows[0];
    return { visits: Number(r.visits), clicks: Number(r.clicks) };
  }
  it('generates unique random codes, rejects reserved or taken codes, and returns campaign URLs', async () => {
    const s = await built.service.create(input({ slug: 'cv' }));
    const c = await built.service.campaigns.create({
      name: 'Generated',
      note: '',
      status: 'active',
      sites: [s.id],
    });
    expect(c.code).toMatch(/^[A-Za-z0-9]{5}$/);
    expect(c.pages[0]).toMatchObject({
      slug: 'cv',
      assigned: true,
      url: `${config.origin}/cv/${c.code}`,
    });
    await expect(
      built.service.campaigns.create({ name: 'Dup', code: c.code, note: '', status: 'active' }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      built.service.campaigns.create({ name: 'Bad', code: 'admin', note: '', status: 'active' }),
    ).rejects.toThrow();
    await expect(
      built.service.campaigns.create({ name: 'X', note: '', status: 'active', sites: ['nope'] }),
    ).rejects.toMatchObject({ status: 400 });
    const renamed = await built.service.campaigns.update(c.id, { code: 'Acme-2' });
    expect(renamed.pages[0].url).toBe(`${config.origin}/cv/Acme-2`);
    expect(await status('/cv/' + c.code)).toBe(200);
    expect(
      (await db.query('SELECT campaign_id FROM events')).rows.map((r) => r.campaign_id),
    ).toEqual([null]);
  });
  it('attributes visits on normal pages and falls back to unattributed for unusable codes', async () => {
    const { s, c } = await setup();
    const other = await built.service.campaigns.create({
      name: 'Other',
      code: 'other',
      note: '',
      status: 'active',
    });
    expect(await status('/cv')).toBe(200);
    expect(await status('/cv/acme')).toBe(200);
    expect(await status('/cv/unknown')).toBe(200);
    expect(await status('/cv/other')).toBe(200);
    expect(await status('/cv/ACME')).toBe(200);
    for (const st of ['inactive', 'archived'] as const) {
      await built.service.campaigns.setState(c.id, st);
      expect(await status('/cv/acme')).toBe(200);
    }
    await built.service.campaigns.setState(c.id, 'active');
    await request(built.app).get('/cv/acme').set('User-Agent', 'Googlebot');
    await request(built.app).head('/cv/acme').set('User-Agent', 'Mozilla/5.0');
    const site = await built.service.get(s.id);
    expect(site.visits).toBe(7);
    expect((await pair(s.id, c.id)).visits).toBe(1);
    expect((await built.service.campaigns.get(other.id)).visits).toBe(0);
    const a = await built.service.analytics(s.id);
    expect(a.campaigns).toEqual([
      expect.objectContaining({ code: 'acme', name: 'Example Company', visits: 1, assigned: true }),
    ]);
    expect(a.unattributed).toMatchObject({ visits: 6, clicks: 0 });
    const filtered = await built.service.analytics(s.id, 30, 100, 0, 'acme');
    expect(filtered.events).toHaveLength(1);
    expect(filtered.daily[0]).toMatchObject({ visits: 1 });
    expect(filtered.events[0].campaign).toMatchObject({ code: 'acme' });
    await built.service.setState(s.id, 'inactive');
    expect(await status('/cv')).toBe(404);
    expect(await status('/cv/acme')).toBe(404);
  });
  it('serves campaign-only pages only through active assigned campaign URLs', async () => {
    const { s, c } = await setup({ campaignOnly: true });
    await built.service.campaigns.create({
      name: 'Other',
      code: 'other',
      note: '',
      status: 'active',
    });
    expect(s.campaignOnly).toBe(true);
    expect(await status('/cv')).toBe(404);
    expect((await request(built.app).get('/api/public/sites/cv')).status).toBe(404);
    expect(await status('/cv/unknown')).toBe(404);
    expect(await status('/cv/other')).toBe(404);
    expect(await status('/cv/acme')).toBe(200);
    const pub = await request(built.app).get('/api/public/sites/cv?c=acme');
    expect(pub.status).toBe(200);
    expect(pub.body.campaign).toBe('acme');
    for (const st of ['inactive', 'archived'] as const) {
      await built.service.campaigns.setState(c.id, st);
      expect(await status('/cv/acme')).toBe(404);
    }
    await built.service.campaigns.setState(c.id, 'active');
    // Links of a campaign-only page work only with a usable campaign code.
    expect(await status('/r/' + s.links[0].id)).toBe(404);
    expect(await status('/r/' + s.links[0].id + '?c=other')).toBe(404);
    expect(await status('/r/' + s.links[0].id + '?c=acme')).toBe(302);
    // A full update without campaignOnly keeps the page private.
    const { campaignOnly: _, ...rest } = await built.service.get(s.id);
    expect((await built.service.update(s.id, rest)).campaignOnly).toBe(true);
    const copy = await built.service.duplicate(s.id);
    expect(copy).toMatchObject({ campaignOnly: true, campaigns: [] });
    const open = await built.service.update(s.id, { ...rest, campaignOnly: false });
    expect(open.campaignOnly).toBe(false);
    expect(await status('/cv')).toBe(200);
    await built.service.setState(s.id, 'archived');
    expect(await status('/cv/acme')).toBe(404);
  });
  it('keeps attribution for clicks, downloads, and embeds and ignores forged codes', async () => {
    const pdf = Buffer.from('%PDF-1.7\n%%EOF\n');
    const f = await built.service.uploadPdf(
      (await import('node:stream')).Readable.from([pdf]),
      'CV.pdf',
      1024,
    );
    const { s, c } = await setup({
      links: [
        {
          url: 'https://example.com/path',
          title: 'Example',
          imageUrl: 'https://example.com/i.jpg',
        },
        { kind: 'file', fileId: f.id },
        {
          url: 'https://youtu.be/dQw4w9WgXcQ',
          embed: true,
          title: 'Video',
          imageUrl: 'https://i.ytimg.com/test.jpg',
        },
      ],
    });
    const other = await built.service.campaigns.create({
      name: 'Other',
      code: 'other',
      note: '',
      status: 'active',
    });
    const [link, file, video] = s.links;
    expect(await status('/r/' + link.id + '?c=acme')).toBe(302);
    expect(await status('/r/' + file.id + '?c=acme')).toBe(200);
    const embed = await browser(
      request(built.app).post('/api/public/links/' + video.id + '/embed?c=acme'),
    ).send({});
    expect(embed.status).toBe(200);
    expect(await status('/r/' + link.id + '?c=other')).toBe(302);
    expect(await status('/r/' + link.id + '?c=%27%3B--')).toBe(302);
    const site = await built.service.get(s.id);
    expect(site.clicks).toBe(5);
    expect((await pair(s.id, c.id)).clicks).toBe(3);
    const detail = await built.service.campaigns.get(c.id);
    expect(detail.clicks).toBe(3);
    expect(detail.pages[0].links.map((l) => l.clicks)).toEqual([1, 1, 1]);
    expect((await built.service.campaigns.get(other.id)).clicks).toBe(0);
    const a = await built.service.campaigns.analytics(c.id);
    expect(a.events.map((e) => e.target).sort()).toEqual(['download', 'embed', 'outbound']);
    expect(a.daily[0]).toMatchObject({ clicks: 3 });
  });
  it('attributes redirect and PDF redirect pages', async () => {
    const { s, c } = await setup({ mode: 'redirect' });
    const r = await human(request(built.app).get('/cv/acme'));
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('https://example.com/path');
    expect((await pair(s.id, c.id)).visits).toBe(1);
    expect((await pair(s.id, c.id)).clicks).toBe(1);
    const f = await built.service.uploadPdf(
      (await import('node:stream')).Readable.from([Buffer.from('%PDF-1.7\n')]),
      'Flyer.pdf',
      1024,
    );
    const p = await built.service.create(
      input({
        slug: 'flyer',
        mode: 'redirect',
        campaignOnly: true,
        campaignIds: [c.id],
        links: [{ kind: 'file', fileId: f.id }],
      }),
    );
    expect(await status('/flyer')).toBe(404);
    const d = await human(request(built.app).get('/flyer/acme'));
    expect(d.status).toBe(200);
    expect(d.headers['content-disposition']).toContain('Flyer.pdf');
    expect((await pair(p.id, c.id)).clicks).toBe(1);
    expect((await built.service.campaigns.get(c.id)).visits).toBe(2);
  });
  it('never exposes campaign names or notes publicly', async () => {
    await setup();
    const html = await human(request(built.app).get('/cv/acme'));
    const json = await request(built.app).get('/api/public/sites/cv?c=acme');
    for (const body of [html.text, JSON.stringify(json.body)]) {
      expect(body).not.toContain('Example Company');
      expect(body).not.toContain('Applied for the senior role');
    }
    expect(html.text).toContain(`<meta property="og:url" content="${config.origin}/cv/acme">`);
    expect(json.body).not.toHaveProperty('campaignOnly');
  });
  it('keeps analytics when assignments are removed and restores them on reassignment', async () => {
    const { s, c } = await setup();
    await status('/cv/acme');
    let updated = await built.service.update(s.id, { ...s, campaignIds: [] });
    expect(updated.campaigns).toEqual([]);
    expect(await status('/cv/acme')).toBe(200);
    expect((await pair(s.id, c.id)).visits).toBe(1);
    expect((await built.service.analytics(s.id)).campaigns[0]).toMatchObject({
      assigned: false,
      visits: 1,
    });
    expect((await built.service.campaigns.get(c.id)).pages[0]).toMatchObject({
      assigned: false,
      visits: 1,
    });
    const back = await built.service.campaigns.update(c.id, { addSites: ['cv'] });
    expect(back.pages[0]).toMatchObject({ assigned: true, visits: 1 });
    await status('/cv/acme');
    expect((await pair(s.id, c.id)).visits).toBe(2);
    updated = await built.service.get(s.id);
    expect(updated.campaigns).toEqual([
      expect.objectContaining({ code: 'acme', url: `${config.origin}/cv/acme` }),
    ]);
    const removed = await built.service.campaigns.update(c.id, { removeSites: [s.id] });
    expect(removed.pages[0].assigned).toBe(false);
    const listed = await built.service.list();
    expect(listed[0].campaigns).toEqual([]);
  });
  it('exports campaign codes in CSV and serves the admin campaign API', async () => {
    const { s, c } = await setup();
    await status('/cv/acme');
    await status('/cv');
    const { a, csrf } = await signedIn();
    const csv = await a.get('/api/admin/sites/' + s.id + '/events.csv');
    expect(csv.text).toContain('campaign_code');
    expect(csv.text).toContain('"acme"');
    expect(csv.text).not.toContain('Example Company');
    const listed = await a.get('/api/admin/campaigns?status=active');
    expect(listed.body[0]).toMatchObject({
      code: 'acme',
      pages: [expect.objectContaining({ slug: 'cv' })],
    });
    const created = await browser(a.post('/api/admin/campaigns'))
      .set('X-CSRF-Token', csrf)
      .send({ name: 'Inline' });
    expect(created.status).toBe(201);
    const patched = await browser(a.patch('/api/admin/campaigns/' + created.body.id))
      .set('X-CSRF-Token', csrf)
      .send({ sites: [s.id], code: 'inline' });
    expect(patched.body.pages[0].url).toBe(`${config.origin}/cv/inline`);
    const archived = await browser(a.patch('/api/admin/campaigns/' + c.id + '/status'))
      .set('X-CSRF-Token', csrf)
      .send({ status: 'archived' });
    expect(archived.body.status).toBe('archived');
    const stats = await a.get('/api/admin/campaigns/' + c.id + '/analytics?days=7');
    expect(stats.body.events).toHaveLength(1);
    expect((await a.get('/api/admin/sites')).body[0].campaigns.map((x: any) => x.code)).toEqual([
      'acme',
      'inline',
    ]);
  });
});
describe('link icons', () => {
  it('replaces rules as a whole list when saves overlap', async () => {
    const first = [{ pattern: 'first.example', icon: 'book' as const }];
    const second = [{ pattern: 'second.example', icon: 'code' as const }];
    await Promise.all([built.service.setIconRules(first), built.service.setIconRules(second)]);
    expect([first, second]).toContainEqual(await built.service.iconRules());
  });
  const links = [
    { url: 'https://realpython.com/courses/some-course/', title: 'Course' },
    { url: 'https://realpython.com/some-tutorial/', title: 'Tutorial', icon: 'book' },
    { url: 'https://github.com/someone', title: 'Code' },
    { kind: 'section', title: 'Heading', icon: 'graduation-cap' },
  ];
  it('keeps manual icons, resolves the rest from rules, and never publishes the rules', async () => {
    const { a, csrf } = await signedIn();
    const rules = await browser(a.put('/api/admin/icon-rules'))
      .set('X-CSRF-Token', csrf)
      .send({ rules: [{ pattern: 'https://www.realpython.com/courses/*', icon: 'circle-play' }] });
    expect(rules.status).toBe(200);
    expect(rules.body).toEqual([
      { pattern: 'https://www.realpython.com/courses/*', icon: 'circle-play' },
    ]);
    const saved = await browser(a.post('/api/admin/sites'))
      .set('X-CSRF-Token', csrf)
      .send(input({ links }));
    expect(saved.status).toBe(201);
    expect(saved.body.links.map((l: any) => l.icon)).toEqual(['', 'book', '', 'graduation-cap']);
    const pub = await request(built.app).get('/api/public/sites/Ab3xY');
    expect(pub.body.links.map((l: any) => l.icon)).toEqual([
      'circle-play',
      'book',
      'github',
      'graduation-cap',
    ]);
    expect(JSON.stringify(pub.body)).not.toContain('courses/*');
    // A full update that omits icons keeps the manual choice.
    const updated = await browser(a.put('/api/admin/sites/' + saved.body.id))
      .set('X-CSRF-Token', csrf)
      .send(
        input({
          links: saved.body.links.map(({ icon: _, ...l }: any) => ({
            ...l,
            ...(l.kind === 'section' ? { url: '', imageUrl: '' } : {}),
          })),
        }),
      );
    expect(updated.status).toBe(200);
    expect(updated.body.links[1].icon).toBe('book');
    expect(updated.body.links[3].icon).toBe('graduation-cap');
    const reset = await browser(a.put('/api/admin/sites/' + saved.body.id))
      .set('X-CSRF-Token', csrf)
      .send(
        input({
          links: updated.body.links.map((l: any) => ({
            ...l,
            ...(l.kind === 'section' ? { icon: '' } : {}),
          })),
        }),
      );
    expect(reset.status).toBe(200);
    const resetPublic = await request(built.app).get('/api/public/sites/Ab3xY');
    expect(resetPublic.body.links[3].icon).toBe('layer-group');
  });
  it('shows the full URL by default and keeps a domain-only choice on updates', async () => {
    const { a, csrf } = await signedIn();
    const saved = await browser(a.post('/api/admin/sites'))
      .set('X-CSRF-Token', csrf)
      .send(
        input({
          links: [
            { url: 'https://example.com/full', title: 'Full' },
            { url: 'https://example.com/short', title: 'Short', fullUrl: false },
          ],
        }),
      );
    expect(saved.status).toBe(201);
    expect(saved.body.links.map((l: any) => l.fullUrl)).toEqual([true, false]);
    const updated = await browser(a.put('/api/admin/sites/' + saved.body.id))
      .set('X-CSRF-Token', csrf)
      .send(input({ links: saved.body.links.map(({ fullUrl: _, ...l }: any) => l) }));
    expect(updated.body.links.map((l: any) => l.fullUrl)).toEqual([true, false]);
    const pub = await request(built.app).get('/api/public/sites/Ab3xY');
    expect(pub.body.links.map((l: any) => l.fullUrl)).toEqual([true, false]);
  });
  it('rejects unknown icons on links and sections, and malformed rules', async () => {
    const { a, csrf } = await signedIn();
    const post = (body: any) =>
      browser(a.post('/api/admin/sites')).set('X-CSRF-Token', csrf).send(body);
    expect(
      (await post({ ...input(), links: [{ url: 'https://example.com', icon: 'skull' }] })).status,
    ).toBe(400);
    expect(
      (
        await post({
          ...input(),
          links: [{ url: 'https://example.com' }, { kind: 'section', title: 'H', icon: 'unknown' }],
        })
      ).status,
    ).toBe(400);
    for (const rules of [[{ pattern: 'a b', icon: 'book' }], [{ pattern: 'x.com', icon: 'nope' }]])
      expect(
        (await browser(a.put('/api/admin/icon-rules')).set('X-CSRF-Token', csrf).send({ rules }))
          .status,
      ).toBe(400);
  });
});
describe('stored previews', () => {
  const png = () =>
    sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .png()
      .toBuffer();
  const stored = /^http:\/\/localhost:3000\/api\/public\/images\/[a-f0-9]{64}$/;
  const page = (links: any[], slug = 'Ab3xY') =>
    input({
      slug,
      links: links.map((l) => ({ title: 'Custom title', ...l })),
    });
  it('stores link images, warns when it cannot, and keeps custom titles out of the cache', async () => {
    const { a, csrf } = await signedIn();
    const failed = await browser(a.post('/api/admin/sites'))
      .set('X-CSRF-Token', csrf)
      .send(input());
    expect(failed.status).toBe(201);
    expect(failed.body.warnings).toHaveLength(1);
    expect(failed.body.links[0].imageUrl).toBe('https://example.com/image.jpg');
    expect((await request(built.app).get('/api/public/sites/Ab3xY')).body.links[0].imageUrl).toBe(
      '',
    );
    // A recent failure is not refetched on the next save.
    vi.mocked(fetchImage).mockResolvedValue(await png());
    vi.mocked(fetchImage).mockClear();
    await browser(a.put('/api/admin/sites/' + failed.body.id))
      .set('X-CSRF-Token', csrf)
      .send(input());
    expect(fetchImage).not.toHaveBeenCalled();
    built.service.previews.failedSources.clear();
    const saved = await browser(a.put('/api/admin/sites/' + failed.body.id))
      .set('X-CSRF-Token', csrf)
      .send(input());
    expect(saved.body.warnings).toBeUndefined();
    expect(saved.body.links[0].imageUrl).toMatch(stored);
    const pub = await request(built.app).get('/api/public/sites/Ab3xY');
    expect(pub.body.links[0].imageUrl).toBe(saved.body.links[0].imageUrl);
    const image = await request(built.app).get(new URL(pub.body.links[0].imageUrl).pathname);
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/webp');
    expect((await db.query('SELECT * FROM preview_cache')).rows).toHaveLength(0);
  });
  it('recognizes stored images saved under another origin', async () => {
    const { a, csrf } = await signedIn();
    vi.mocked(fetchImage).mockResolvedValue(await png());
    const saved = await browser(a.post('/api/admin/sites')).set('X-CSRF-Token', csrf).send(input());
    const moved = saved.body.links[0].imageUrl.replace(
      'http://localhost:3000',
      'https://old.example',
    );
    await db.query('UPDATE links SET image_url=$1', [moved]);
    expect((await request(built.app).get('/api/public/sites/Ab3xY')).body.links[0].imageUrl).toBe(
      saved.body.links[0].imageUrl,
    );
  });
  it('imports a laptop image that repairs broken and missing link images, but keeps working ones', async () => {
    const { a, csrf } = await signedIn();
    await browser(a.post('/api/admin/sites'))
      .set('X-CSRF-Token', csrf)
      .send(
        page([
          {
            url: 'https://realpython.com/article/',
            imageUrl: 'https://realpython.com/blocked.jpg',
          },
          { url: 'https://www.realpython.com/article?utm_source=x', imageUrl: '' },
          { url: 'https://example.com/other', imageUrl: 'https://example.com/other.jpg' },
        ]),
      );
    vi.mocked(fetchImage).mockResolvedValue(await png());
    const other = await browser(a.post('/api/admin/sites'))
      .set('X-CSRF-Token', csrf)
      .send(
        page(
          [{ url: 'https://realpython.com/article/', imageUrl: 'https://example.com/ok.jpg' }],
          'Other',
        ),
      );
    const working = other.body.links[0].imageUrl;
    expect(working).toMatch(stored);
    const imported = await browser(a.post('/api/admin/tools/import_preview'))
      .set('X-CSRF-Token', csrf)
      .send({
        url: 'https://realpython.com/article',
        title: 'Article',
        imageBase64: (
          await sharp({ create: { width: 9, height: 9, channels: 3, background: '#fff' } })
            .png()
            .toBuffer()
        ).toString('base64'),
      });
    expect(imported.status).toBe(200);
    expect(imported.body.updated).toBe(2);
    const pub = await request(built.app).get('/api/public/sites/Ab3xY');
    expect(pub.body.links.map((l: any) => l.imageUrl)).toEqual([
      imported.body.imageUrl,
      imported.body.imageUrl,
      '',
    ]);
    expect((await request(built.app).get('/api/public/sites/Other')).body.links[0].imageUrl).toBe(
      working,
    );
  });
  it('falls back to the cached target preview, never to the external image', async () => {
    const { a, csrf } = await signedIn();
    await browser(a.post('/api/admin/sites'))
      .set('X-CSRF-Token', csrf)
      .send(
        page([
          {
            url: 'https://realpython.com/article/',
            imageUrl: 'https://realpython.com/blocked.jpg',
          },
        ]),
      );
    const imageUrl = await built.service.previews.store(await png());
    await built.service.previews.remember('https://realpython.com/article/', 'T', '', imageUrl);
    expect((await request(built.app).get('/api/public/sites/Ab3xY')).body.links[0].imageUrl).toBe(
      imageUrl,
    );
  });
  it('backfills past failing targets instead of retrying the same batch', async () => {
    const { a, csrf } = await signedIn();
    await browser(a.post('/api/admin/sites'))
      .set('X-CSRF-Token', csrf)
      .send(
        page(
          Array.from({ length: 5 }, (_, i) => ({
            url: `https://example.com/${i}`,
            imageUrl: `https://example.com/${i}.jpg`,
          })),
        ),
      );
    built.service.previews.failedSources.clear();
    vi.mocked(fetchImage).mockImplementation(async (url: string) => {
      if (/[01]\.jpg$/.test(url)) throw new Error('Blocked');
      return png();
    });
    const first = await built.service.previews.backfill({ limit: 2 });
    expect(first).toMatchObject({
      updated: 0,
      failed: ['https://example.com/0', 'https://example.com/1'],
    });
    expect(first.remainingTargets).toBe(3);
    const second = await built.service.previews.backfill({ limit: 2 });
    expect(second).toMatchObject({ updated: 2, failed: [], retryLater: 2, remainingTargets: 1 });
    const third = await built.service.previews.backfill({ limit: 2 });
    expect(third).toMatchObject({ updated: 1, retryLater: 2, remainingTargets: 0 });
  });
  it('previews for read-only agents without storing anything', async () => {
    vi.mocked(fetchImage).mockResolvedValue(await png());
    const preview = await built.service.previews.preview('https://example.com/read', false);
    expect(preview.imageUrl).toBe('https://example.com/image.jpg');
    expect(fetchImage).not.toHaveBeenCalled();
    expect((await db.query('SELECT * FROM preview_images')).rows).toHaveLength(0);
  });
  it('keeps old images and mappings that saved links still use', async () => {
    const { a, csrf } = await signedIn();
    vi.mocked(fetchImage).mockResolvedValue(await png());
    const saved = await browser(a.post('/api/admin/sites')).set('X-CSRF-Token', csrf).send(input());
    await built.service.previews.remember(
      'https://example.com/path',
      'T',
      '',
      saved.body.links[0].imageUrl,
    );
    await db.query("UPDATE preview_images SET created_at=now() - interval '2 years'");
    await db.query("UPDATE preview_sources SET created_at=now() - interval '2 years'");
    await db.query("UPDATE preview_cache SET updated_at=now() - interval '2 years'");
    await built.service.cleanup();
    expect((await db.query('SELECT * FROM preview_images')).rows).toHaveLength(1);
    expect((await request(built.app).get('/api/public/sites/Ab3xY')).body.links[0].imageUrl).toBe(
      saved.body.links[0].imageUrl,
    );
    await db.query('TRUNCATE sites CASCADE');
    await built.service.cleanup();
    expect((await db.query('SELECT * FROM preview_images')).rows).toHaveLength(0);
  });
});
describe('markdown for agents', () => {
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
  async function upload(name: string) {
    const s = await login(db, 'owner@example.com', 'correct-password-123');
    return (
      await browser(request(built.app).post('/api/admin/files'))
        .set('Cookie', 'lg_session=' + s.token)
        .set('X-CSRF-Token', s.csrfToken)
        .set('Content-Type', 'application/pdf')
        .set('X-Filename', encodeURIComponent(name))
        .send(pdf)
    ).body;
  }
  const md = (path: string, agent = 'Claude-User') =>
    request(built.app).get(path).set('User-Agent', agent);
  const visits = async () =>
    (
      await db.query(
        "SELECT target,campaign_id FROM events WHERE kind='visit' ORDER BY occurred_at",
      )
    ).rows;
  it('serves collection pages as Markdown by suffix and Accept, with sections, PDFs, and discovery', async () => {
    const f = await upload('Report.pdf');
    const s = await built.service.create(
      input({
        description: 'Things I wrote',
        links: [
          { kind: 'section', title: 'Articles', description: 'Some *tutorials* I wrote' },
          { url: 'https://example.com/a_(b)', title: 'Example', description: 'Read *this*' },
          { kind: 'file', fileId: f.id, title: '', description: '' },
        ],
      }),
    );
    const expected = [
      '# Test page',
      'Things I wrote',
      '## Articles',
      'Some \\*tutorials\\* I wrote',
      '- [Example](https://example.com/a_%28b%29) — Read \\*this\\*\n' +
        `- [Report.pdf](${config.origin}/r/${s.links[2].id}) — PDF, 1 KB`,
    ].join('\n\n');
    const r = await md('/Ab3xY.md');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(r.headers['vary']).toContain('Accept');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.text).toBe(expected + '\n');
    for (const leak of ['Secret campaign note', f.id, config.filesDir, s.id])
      expect(r.text).not.toContain(leak);
    const negotiated = await md('/Ab3xY').set('Accept', 'text/markdown, text/html;q=0.5');
    expect(negotiated.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(negotiated.text).toBe(r.text);
    const html = await md('/Ab3xY', 'Mozilla/5.0').set('Accept', 'text/html,*/*;q=0.8');
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.headers['vary']).toContain('Accept');
    expect(html.text).toContain(
      `<link rel="alternate" type="text/markdown" href="${config.origin}/Ab3xY.md">`,
    );
    expect((await md('/Ab3xY', 'Mozilla/5.0')).headers['content-type']).toContain('text/html');
    // Only lowercase .md; other suffixes are just unknown slugs.
    expect((await md('/Ab3xY.MD')).status).toBe(404);
    expect((await md('/Ab3xY.txt')).status).toBe(404);
  });
  it('counts agent reads as visits, bots included, but not HEAD requests', async () => {
    const s = await built.service.create(input());
    await md('/Ab3xY.md', 'curl/8.7.1');
    await md('/Ab3xY').set('Accept', 'text/markdown');
    await request(built.app).head('/Ab3xY.md').set('User-Agent', 'Claude-User');
    await md('/Ab3xY', 'Mozilla/5.0');
    expect(await built.service.get(s.id)).toMatchObject({ visits: 3, agentVisits: 2, clicks: 0 });
    expect((await visits()).map((v) => v.target).sort()).toEqual(['markdown', 'markdown', 'page']);
    const a = await built.service.analytics(s.id);
    expect(a.agentVisits).toBe(2);
    expect((await built.service.list())[0].agentVisits).toBe(2);
  });
  it('escapes page text so it cannot change the document structure', async () => {
    await built.service.create(
      input({
        title: '# [Click](https://evil.example) <script>',
        description: '- item\n\n## Fake heading\n![x](y) `code` _a_ ~b~ | c',
        links: [
          { kind: 'section', title: '1. Not a list' },
          {
            url: 'https://example.com',
            title: 'a]](https://evil.example)',
            description: '> quote',
          },
        ],
      }),
    );
    const r = await md('/Ab3xY.md');
    expect(r.text).toBe(
      [
        '# \\# \\[Click\\]\\(https://evil.example\\) \\<script\\>',
        '\\- item ## Fake heading \\!\\[x\\]\\(y\\) \\`code\\` \\_a\\_ \\~b\\~ \\| c',
        '## 1\\. Not a list',
        '- [a\\]\\]\\(https://evil.example\\)](https://example.com) — \\> quote',
      ].join('\n\n') + '\n',
    );
  });
  it('matches the HTML route for campaigns, campaign-only pages, and unavailable pages', async () => {
    const f = await upload('Report.pdf');
    const s = await built.service.create(
      input({ slug: 'cv', links: [...input().links, { kind: 'file', fileId: f.id }] }),
    );
    const c = await built.service.campaigns.create({
      name: 'Example Company',
      code: 'acme',
      note: 'Applied for the senior role',
      status: 'active',
      sites: ['cv'],
    });
    const r = await md('/cv/acme.md');
    expect(r.status).toBe(200);
    expect(r.text).toContain(`(${config.origin}/r/${s.links[1].id}?c=acme)`);
    for (const leak of ['Example Company', 'Applied for the senior role', c.id])
      expect(r.text).not.toContain(leak);
    const html = await md('/cv/acme', 'Mozilla/5.0');
    expect(html.text).toContain(`href="${config.origin}/cv/acme.md"`);
    // Unusable codes fall back to the unattributed page.
    const fallback = await md('/cv/nope.md');
    expect(fallback.status).toBe(200);
    expect(fallback.text).not.toContain('?c=');
    expect((await visits()).map((v) => [v.target, v.campaign_id])).toEqual([
      ['markdown', c.id],
      ['page', c.id],
      ['markdown', null],
    ]);
    await built.service.update(s.id, { ...(await built.service.get(s.id)), campaignOnly: true });
    expect((await md('/cv.md')).status).toBe(404);
    expect((await md('/cv/nope.md')).status).toBe(404);
    expect((await md('/cv/acme.md')).status).toBe(200);
    for (const st of ['inactive', 'archived'] as const) {
      await built.service.setState(s.id, st);
      const gone = await md('/cv/acme.md');
      expect(gone.status).toBe(404);
      expect(gone.headers['content-type']).toBe('text/markdown; charset=utf-8');
      expect(gone.text).toContain('# Page unavailable');
      expect((await md('/cv/acme').set('Accept', 'text/markdown')).status).toBe(404);
    }
    for (const reserved of ['/admin.md', '/api.md', '/r.md', '/mcp.md'])
      expect((await md(reserved)).status).toBe(404);
  });
  it('points redirect pages at their destination instead of redirecting', async () => {
    const s = await built.service.create(
      input({
        mode: 'redirect',
        links: [{ url: 'https://example.com/x', title: 'Private title' }],
      }),
    );
    const r = await md('/Ab3xY.md');
    expect(r.status).toBe(200);
    expect(r.text).toBe('This link redirects to [https://example.com/x](https://example.com/x).\n');
    expect(await built.service.get(s.id)).toMatchObject({ visits: 1, agentVisits: 1, clicks: 0 });
    const f = await upload('Flyer.pdf');
    await built.service.create(
      input({ slug: 'flyer', mode: 'redirect', links: [{ kind: 'file', fileId: f.id }] }),
    );
    const file = await md('/flyer.md');
    expect(file.text).toBe(
      `This link redirects to [${config.origin}/flyer](${config.origin}/flyer).\n`,
    );
    expect(file.text).not.toContain(f.id);
  });
});
describe('slug rules the markdown routes rely on', () => {
  it('never generates slugs or codes with a dot', () => {
    for (let i = 0; i < 1000; i++) expect(randomSlug()).toMatch(/^[A-Za-z0-9]{5}$/);
  });
  it('rejects .md slugs and codes through the API and MCP tools', async () => {
    const { a, csrf } = await signedIn();
    const t = await createAgentToken(db, 'Slug rules', 'write', 1);
    const port = (listener.address() as { port: number }).port;
    const c = new Client(
      { name: 'integration-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: 'Bearer ' + t.token } },
      }),
    );
    try {
      for (const bad of ['foo.md', 'foo.MD', 'foo.Md']) {
        const page = await browser(a.post('/api/admin/sites'))
          .set('X-CSRF-Token', csrf)
          .send({ ...input(), slug: bad });
        expect(page.status).toBe(400);
        const campaign = await browser(a.post('/api/admin/campaigns'))
          .set('X-CSRF-Token', csrf)
          .send({ name: 'X', code: bad, note: '', status: 'active' });
        expect(campaign.status).toBe(400);
        const tool = await c.callTool({
          name: 'create_site',
          arguments: { ...input(), slug: bad },
        });
        expect(tool.isError).toBe(true);
        const code = await c.callTool({
          name: 'create_campaign',
          arguments: { name: 'X', code: bad },
        });
        expect(code.isError).toBe(true);
      }
      expect(await built.service.list()).toHaveLength(0);
      expect(await built.service.campaigns.list()).toHaveLength(0);
    } finally {
      await c.close();
    }
  });
});
describe('MCP 2026-07-28 and access scopes', () => {
  async function client(scope: 'read' | 'write') {
    const t = await createAgentToken(db, 'Test client', scope, 1);
    const port = (listener.address() as { port: number }).port;
    const c = new Client(
      { name: 'integration-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: 'Bearer ' + t.token } },
      }),
    );
    return { c, t };
  }
  it('requires a bearer token even when a browser admin session is present', async () => {
    const { a } = await signedIn();
    expect(
      (await a.post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status,
    ).toBe(401);
  });
  it('negotiates modern MCP, discovers tools, and executes authenticated operations', async () => {
    const { c } = await client('write');
    try {
      expect(c.getProtocolEra()).toBe('modern');
      const list = await c.listTools();
      expect(list.tools.map((t) => t.name)).toContain('duplicate_site');
      const rules = [{ pattern: 'example.com/*', icon: 'book' }];
      const savedRules = await c.callTool({ name: 'set_icon_rules', arguments: { rules } });
      expect(savedRules.isError).not.toBe(true);
      const listedRules = await c.callTool({ name: 'list_icon_rules', arguments: {} });
      expect(JSON.parse((listedRules.content as any)[0].text)).toEqual(rules);
      const created = await c.callTool({ name: 'create_site', arguments: input() });
      expect(created.isError).not.toBe(true);
      const result = JSON.parse((created.content as any)[0].text);
      expect(result.slug).toBe('Ab3xY');
      const campaign = await c.callTool({
        name: 'create_campaign',
        arguments: { name: 'Example Company', sites: ['Ab3xY'] },
      });
      const made = JSON.parse((campaign.content as any)[0].text);
      expect(made.code).toMatch(/^[A-Za-z0-9]{5}$/);
      expect(made.pages[0].url).toBe(`${config.origin}/Ab3xY/${made.code}`);
      const changed = await c.callTool({
        name: 'update_campaign',
        arguments: { id: made.id, code: 'example' },
      });
      expect(JSON.parse((changed.content as any)[0].text).pages[0].url).toBe(
        `${config.origin}/Ab3xY/example`,
      );
      const site = await c.callTool({ name: 'get_site', arguments: { id: result.id } });
      expect(JSON.parse((site.content as any)[0].text)).toMatchObject({
        campaignOnly: false,
        campaigns: [expect.objectContaining({ code: 'example' })],
      });
      const listed = await c.callTool({ name: 'list_sites', arguments: {} });
      expect(JSON.parse((listed.content as any)[0].text)[0].note).toBe('Secret campaign note');
    } finally {
      await c.close();
    }
  });
  it('hides write tools from read tokens and enforces scope, expiry, and revocation', async () => {
    const { c, t } = await client('read');
    try {
      const names = (await c.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain('create_site');
      expect(names).not.toContain('create_campaign');
      expect(names).not.toContain('set_icon_rules');
      expect(names).toContain('list_icon_rules');
      await expect(
        c.callTool({ name: 'set_icon_rules', arguments: { rules: [] } }),
      ).rejects.toThrow('not found');
      expect(names).toEqual(expect.arrayContaining(['list_campaigns', 'get_campaign']));
      await expect(c.callTool({ name: 'create_site', arguments: input() })).rejects.toThrow(
        'not found',
      );
      const row = (await db.query('SELECT * FROM agent_tokens WHERE id=$1', [t.id])).rows[0];
      expect(row.token_hash).toBe(digest(t.token));
      expect(row).not.toHaveProperty('token');
      await db.query('DELETE FROM agent_tokens WHERE id=$1', [t.id]);
      expect(
        (
          await request(built.app)
            .post('/mcp')
            .set('Authorization', 'Bearer ' + t.token)
            .send({})
        ).status,
      ).toBe(401);
      const exp = await createAgentToken(db, 'Expired', 'read', 1);
      await db.query("UPDATE agent_tokens SET expires_at=now()-interval '1 second' WHERE id=$1", [
        exp.id,
      ]);
      expect(
        (
          await request(built.app)
            .post('/mcp')
            .set('Authorization', 'Bearer ' + exp.token)
            .send({})
        ).status,
      ).toBe(401);
    } finally {
      await c.close();
    }
  });
  it('lets write agents upload PDFs and attach them, with the editor upload rules', async () => {
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
    const { c } = await client('write');
    const call = async (args: Record<string, unknown>) => {
      const r = await c.callTool({ name: 'upload_pdf', arguments: args });
      const text = (r.content as any)[0].text;
      return r.isError ? { error: text } : JSON.parse(text);
    };
    try {
      const f = await call({
        filename: 'Lebenslauf Jörg.pdf',
        contentBase64: pdf.toString('base64'),
      });
      expect(f).toEqual({
        fileId: expect.any(String),
        filename: 'Lebenslauf Jörg.pdf',
        size: pdf.length,
      });
      const created = await built.service.create(input());
      const site = await c.callTool({
        name: 'update_site',
        arguments: {
          id: created.id,
          site: {
            ...input(),
            links: [...created.links, { kind: 'file', fileId: f.fileId, title: 'CV' }],
          },
        },
      });
      expect(site.isError).not.toBe(true);
      const item = JSON.parse((site.content as any)[0].text).links[1];
      const download = await request(built.app)
        .get('/r/' + item.id)
        .set('User-Agent', 'Mozilla/5.0')
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (b: Buffer) => chunks.push(b));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        });
      expect(download.body).toEqual(pdf);
      expect(download.headers['content-disposition']).toContain(
        "filename*=UTF-8''Lebenslauf%20J%C3%B6rg.pdf",
      );
      // The same bytes under the same name reuse the file; another name is a new file.
      expect(
        (await call({ filename: 'Lebenslauf Jörg.pdf', contentBase64: pdf.toString('base64') }))
          .fileId,
      ).toBe(f.fileId);
      const sneaky = await call({
        filename: '../../cv\u202efdp.exe',
        contentBase64: pdf.toString('base64'),
      });
      expect(sneaky.filename).toBe('cvfdp.exe.pdf');
      expect(sneaky.fileId).not.toBe(f.fileId);
      expect(existsSync(join(config.filesDir, sneaky.fileId, 'cvfdp.exe.pdf'))).toBe(true);
      expect(
        (await call({ filename: 'x.pdf', contentBase64: Buffer.from('<html>').toString('base64') }))
          .error,
      ).toContain('Only PDF');
      expect((await call({ filename: 'x.pdf', contentBase64: 'not base64!' })).error).toContain(
        'base64',
      );
      const big = Buffer.concat([pdf, Buffer.alloc(70 * 1024)]).toString('base64');
      expect((await call({ filename: 'x.pdf', contentBase64: big })).error).toContain('at most');
      // One byte over the limit passes the length check and fails after decoding.
      const huge = Buffer.concat([pdf, Buffer.alloc(64 * 1024 - pdf.length + 1)]);
      expect(
        (await call({ filename: 'x.pdf', contentBase64: huge.toString('base64') })).error,
      ).toContain('at most');
      // Unattached uploads go after a day, like editor uploads.
      await db.query("UPDATE files SET created_at=now()-interval '2 days'");
      await built.service.cleanup();
      expect(existsSync(join(config.filesDir, sneaky.fileId))).toBe(false);
      expect(existsSync(join(config.filesDir, f.fileId, 'Lebenslauf Jörg.pdf'))).toBe(true);
    } finally {
      await c.close();
    }
    const { c: reader } = await client('read');
    try {
      expect((await reader.listTools()).tools.map((t) => t.name)).not.toContain('upload_pdf');
      await expect(
        reader.callTool({
          name: 'upload_pdf',
          arguments: { filename: 'a.pdf', contentBase64: pdf.toString('base64') },
        }),
      ).rejects.toThrow('not found');
    } finally {
      await reader.close();
    }
  });
  it('rejects modern routing headers that disagree with the JSON-RPC body', async () => {
    const t = await createAgentToken(db, 'Routing', 'read', 1);
    const response = await request(built.app)
      .post('/mcp')
      .set('Authorization', 'Bearer ' + t.token)
      .set('Accept', 'application/json, text/event-stream')
      .set('MCP-Protocol-Version', '2026-07-28')
      .set('Mcp-Method', 'tools/call')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      });
    expect(response.status).toBe(400);
  });
});
