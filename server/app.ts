import express, { type Request, type Response, type NextFunction } from 'express';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { Database } from './db.js';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import { login, session, digest, agentAuth, createAgentToken } from './auth.js';
import { SiteService } from './sites.js';
import { FileStore } from './files.js';
import {
  uuidSchema,
  siteSchema,
  httpUrl,
  statusSchema,
  campaignSchema,
  campaignPatchSchema,
} from '../shared/schemas.js';
import { siteMarkdown } from './markdown.js';
import { toolDescriptors, executeTool, mcpHandler, agentUploadBodyBytes } from './tools.js';
export const isBot = (agent: string) =>
  /bot|crawler|spider|slurp|facebookexternalhit|preview|headless|lighthouse|curl|wget/i.test(agent);
const escaped = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
// JSON bodies let the app show the reason instead of a generic error.
const robotsTag = 'noindex, nofollow, noarchive';
const limiter = (windowMs: number, limit: number, extra: Parameters<typeof rateLimit>[0] = {}) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a moment and try again.' },
    ...extra,
  });
// The campaign code of a public request, from /<slug>/<code> or ?c=<code>.
const campaignCode = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
export const csvCell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  if (/^[\s]*[=+@-]/.test(s) || /^[\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
export function createApp(
  db: Database,
  config: Config,
  renderHtml: (req: Request) => Promise<string> = async () =>
    '<html><head><title>Linkgarden</title></head><body><div id="app"></div></body></html>',
) {
  const app = express();
  const service = new SiteService(
    db,
    new FileStore(config.filesDir, config.maxUploadBytes),
    config.origin,
  );
  const cookieName = config.production ? '__Host-lg_session' : 'lg_session';
  const cookieOptions = {
    httpOnly: true,
    secure: config.production,
    sameSite: 'strict' as const,
    path: '/',
    maxAge: 12 * 3600000,
  };
  app.disable('x-powered-by');
  app.set('trust proxy', config.production ? 1 : false);
  app.use(
    helmet({
      contentSecurityPolicy: config.production
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'https:', 'data:'],
              frameSrc: ['https://www.youtube-nocookie.com', 'https://player.vimeo.com'],
              connectSrc: ["'self'"],
              objectSrc: ["'none'"],
              baseUri: ["'self'"],
              formAction: ["'self'"],
              frameAncestors: ["'none'"],
            },
          }
        : false,
      strictTransportSecurity: config.production ? undefined : false,
    }),
  );
  // Nothing here belongs in search results: pages, PDFs, redirects, or the landing page.
  // Crawlers may fetch everything public so they can see this header.
  app.use((_req, res, next) => {
    res.set('X-Robots-Tag', robotsTag);
    next();
  });
  app.use((req, res, next) => {
    // Render probes health internally; this route has no admin or page data.
    if (req.path === '/health') return next();
    const hosts = new Set([
      new URL(config.origin).hostname,
      ...(config.production ? [] : ['localhost', '127.0.0.1', '[::1]']),
    ]);
    if (!hosts.has(req.hostname)) return res.status(403).json({ error: 'Host is not allowed.' });
    const origin = req.get('origin');
    if (origin && origin !== config.origin)
      return res.status(403).json({ error: 'Origin is not allowed.' });
    next();
  });
  app.get('/health', async (_req, res) => {
    await db.query('SELECT 1');
    res.json({ ok: true });
  });
  const agentLimiter = limiter(60000, 120);
  // Separate from agents: the signed-in admin app makes several requests per view.
  const adminLimiter = limiter(60000, 300);
  const readMcp = mcpHandler(service, 'read'),
    writeMcp = mcpHandler(service, 'write');
  app.all('/mcp', agentLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const auth = await agentAuth(db, req.get('authorization'));
      await toNodeHandler(auth.scope === 'read' ? readMcp : writeMcp, {
        // Room for upload_pdf's base64 content; other calls stay small.
        maxRequestBodySize: agentUploadBodyBytes,
      })(req, res);
    } catch (err) {
      if (err instanceof AppError && !res.headersSent) {
        if (err.status === 401) res.set('WWW-Authenticate', 'Bearer realm="Linkgarden"');
        res.status(err.status).json({ error: err.message });
      } else throw err;
    }
  });
  app.use('/api/admin/tools/import_preview', express.json({ limit: '1mb' }));
  app.use('/api/admin/tools/upload_pdf', express.json({ limit: agentUploadBodyBytes }));
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  // Always a download under the uploaded name: the PDF never renders on this origin.
  const sendPdf = async (req: Request, res: Response, id: string, filename: string) => {
    const path = service.files.path(id, filename);
    const size = (await stat(path).catch(() => null))?.size;
    if (size === undefined) throw new AppError(404, 'File unavailable.');
    // ASCII fallback for old clients; filename* carries the exact UTF-8 name (RFC 6266).
    const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const utf8 = encodeURIComponent(filename).replace(
      /['()*]/g,
      (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
    );
    res.set({
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`,
      'Content-Type': 'application/pdf',
      'Content-Length': String(size),
      'Content-Security-Policy': 'sandbox',
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    await pipeline(service.files.open(id, filename), res);
  };
  const mustOrigin = (req: Request) => {
    if (req.get('origin') !== config.origin)
      throw new AppError(403, 'This action requires the configured same origin.');
  };
  const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
    const s = await session(db, req.cookies[cookieName]);
    if (!s) throw new AppError(401, 'Please sign in.');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      mustOrigin(req);
      if (req.get('x-csrf-token') !== s.csrf_token)
        throw new AppError(403, 'Invalid session CSRF token.');
    }
    next();
  };
  // The signed-in admin's own traffic is never counted, and they can open pages that
  // are not active (the public page shows them a status banner).
  const isAdmin = async (req: Request) =>
    !!req.cookies[cookieName] && !!(await session(db, req.cookies[cookieName]));
  app.get('/api/auth/session', async (req, res) => {
    const s = await session(db, req.cookies[cookieName]);
    const admin = (await db.query('SELECT email FROM admin WHERE id=1')).rows[0];
    res.json({
      authenticated: !!s,
      configured: !!admin,
      email: s ? admin?.email : null,
      csrfToken: s?.csrf_token || null,
      origin: config.origin,
    });
  });
  app.post(
    '/api/auth/login',
    // Only failed attempts count, so signing in on several devices never locks the owner out.
    limiter(15 * 60000, 10, {
      skipSuccessfulRequests: true,
      message: { error: 'Too many failed sign-ins. Please wait 15 minutes and try again.' },
    }),
    async (req, res) => {
      mustOrigin(req);
      const a = z
        .object({ email: z.email().max(254), password: z.string().min(1).max(1024) })
        .parse(req.body);
      const result = await login(db, a.email, a.password);
      if (req.cookies[cookieName])
        await db.query('DELETE FROM sessions WHERE token_hash=$1', [
          digest(req.cookies[cookieName]),
        ]);
      res
        .cookie(cookieName, result.token, cookieOptions)
        .json({ email: result.email, csrfToken: result.csrfToken });
    },
  );
  app.post('/api/auth/logout', requireAdmin, async (req, res) => {
    await db.query('DELETE FROM sessions WHERE token_hash=$1', [digest(req.cookies[cookieName])]);
    res.clearCookie(cookieName, cookieOptions).json({ ok: true });
  });
  app.use('/api/admin', adminLimiter, requireAdmin);
  app.get('/api/admin/sites', async (req, res) => {
    const a = z
      .object({
        status: z.enum(['active', 'inactive', 'archived']).optional(),
        search: z.string().max(200).optional(),
      })
      .parse(req.query);
    res.json(await service.list(a.status, a.search));
  });
  app.post('/api/admin/sites', async (req, res) =>
    res.status(201).json(await service.create(siteSchema.parse(req.body))),
  );
  app.get('/api/admin/sites/:id', async (req, res) =>
    res.json(await service.get(String(req.params.id))),
  );
  app.put('/api/admin/sites/:id', async (req, res) =>
    res.json(await service.update(String(req.params.id), siteSchema.parse(req.body))),
  );
  app.post('/api/admin/sites/:id/duplicate', async (req, res) => {
    const a = z.object({ slug: z.string().optional() }).parse(req.body);
    res.status(201).json(await service.duplicate(String(req.params.id), a.slug));
  });
  app.patch('/api/admin/sites/:id/status', async (req, res) => {
    const a = z.object({ status: z.enum(['active', 'inactive', 'archived']) }).parse(req.body);
    res.json(await service.setState(String(req.params.id), a.status));
  });
  app.patch('/api/admin/sites/:id/note', async (req, res) => {
    const a = z.object({ note: z.string().max(10000) }).parse(req.body);
    res.json(await service.setNote(String(req.params.id), a.note));
  });
  app.post('/api/admin/sites/:id/reset-stats', async (req, res) =>
    res.json(await service.resetStats(String(req.params.id))),
  );
  app.get('/api/admin/sites/:id/analytics', async (req, res) => {
    const a = z
      .object({
        days: z.coerce.number().int().min(1).max(365).default(30),
        limit: z.coerce.number().int().min(1).max(1000).default(100),
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
        campaign: z.string().max(64).optional(),
      })
      .parse(req.query);
    res.json(await service.analytics(String(req.params.id), a.days, a.limit, a.offset, a.campaign));
  });
  app.get('/api/admin/sites/:id/events.csv', async (req, res) => {
    const id = String(req.params.id);
    const site = await service.get(id);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${site.slug}-events.csv"`,
    });
    res.write('timestamp_utc,kind,link_id,target,referrer_origin,campaign_code\r\n');
    let offset = 0;
    while (!res.destroyed) {
      const rows = (
        await db.query(
          "SELECT e.occurred_at,e.kind,e.link_id,e.target,e.referrer,c.code AS campaign_code FROM events e LEFT JOIN campaigns c ON c.id=e.campaign_id WHERE e.site_id=$1 AND e.occurred_at>=now()-interval '365 days' ORDER BY e.occurred_at DESC,e.id LIMIT 1000 OFFSET $2",
          [id, offset],
        )
      ).rows;
      for (const e of rows)
        res.write(
          [
            new Date(e.occurred_at).toISOString(),
            e.kind,
            e.link_id,
            e.target,
            e.referrer,
            e.campaign_code,
          ]
            .map(csvCell)
            .join(',') + '\r\n',
        );
      if (rows.length < 1000) break;
      offset += rows.length;
    }
    res.end();
  });
  const listQuery = z.object({
    status: statusSchema.optional(),
    search: z.string().max(200).optional(),
  });
  app.get('/api/admin/campaigns', async (req, res) => {
    const a = listQuery.parse(req.query);
    res.json(await service.campaigns.list(a.status, a.search));
  });
  app.post('/api/admin/campaigns', async (req, res) =>
    res.status(201).json(await service.campaigns.create(campaignSchema.parse(req.body))),
  );
  app.get('/api/admin/campaigns/:id', async (req, res) =>
    res.json(await service.campaigns.get(String(req.params.id))),
  );
  app.patch('/api/admin/campaigns/:id', async (req, res) =>
    res.json(
      await service.campaigns.update(String(req.params.id), campaignPatchSchema.parse(req.body)),
    ),
  );
  app.patch('/api/admin/campaigns/:id/status', async (req, res) => {
    const a = z.object({ status: statusSchema }).parse(req.body);
    res.json(await service.campaigns.setState(String(req.params.id), a.status));
  });
  app.get('/api/admin/campaigns/:id/analytics', async (req, res) => {
    const a = z
      .object({
        days: z.coerce.number().int().min(1).max(365).default(30),
        limit: z.coerce.number().int().min(1).max(1000).default(100),
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
      })
      .parse(req.query);
    res.json(await service.campaigns.analytics(String(req.params.id), a.days, a.limit, a.offset));
  });
  app.get('/api/admin/icon-rules', async (_req, res) => res.json(await service.iconRules()));
  app.put('/api/admin/icon-rules', async (req, res) =>
    res.json(await service.setIconRules(req.body?.rules)),
  );
  app.post('/api/admin/metadata', limiter(60000, 30), async (req, res) => {
    res.json(await service.previews.preview(httpUrl.parse(req.body.url)));
  });
  app.post('/api/admin/files', limiter(60000, 20), async (req, res) => {
    if (!req.is('application/pdf')) throw new AppError(415, 'Only PDF files can be uploaded.');
    if (Number(req.get('content-length')) > config.maxUploadBytes)
      throw new AppError(
        413,
        `PDFs can be at most ${Math.floor(config.maxUploadBytes / 1048576)} MB.`,
      );
    let name: string;
    try {
      name = decodeURIComponent(req.get('x-filename') || '');
    } catch {
      throw new AppError(400, 'Invalid file name.');
    }
    res.status(201).json(await service.uploadPdf(req, name, config.maxUploadBytes));
  });
  app.get('/api/admin/files/:id', async (req, res) => {
    const file = await service.file(String(req.params.id));
    await sendPdf(req, res, file.id, file.filename);
  });
  app.get('/api/admin/tools', (_req, res) => res.json(toolDescriptors(service)));
  app.post('/api/admin/tools/:name', async (req, res) =>
    res.json(await executeTool(service, String(req.params.name), req.body)),
  );
  app.get('/api/admin/tokens', async (_req, res) =>
    res.json(
      (
        await db.query(
          'SELECT id,name,scope,expires_at AS "expiresAt",created_at AS "createdAt",last_used_at AS "lastUsedAt" FROM agent_tokens ORDER BY created_at DESC',
        )
      ).rows,
    ),
  );
  app.post('/api/admin/tokens', async (req, res) => {
    const a = z
      .object({
        name: z.string().trim().min(1).max(100),
        scope: z.enum(['read', 'write']).default('read'),
        days: z.number().int().min(1).max(365).default(90),
      })
      .parse(req.body);
    res.status(201).json(await createAgentToken(db, a.name, a.scope, a.days));
  });
  app.delete('/api/admin/tokens/:id', async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    await db.query('DELETE FROM agent_tokens WHERE id=$1', [id]);
    res.json({ ok: true });
  });
  app.get('/api/public/images/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!/^[a-f0-9]{64}$/.test(id)) throw new AppError(404, 'Image unavailable.');
    const image = (await db.query('SELECT bytes FROM preview_images WHERE id=$1', [id])).rows[0];
    if (!image) throw new AppError(404, 'Image unavailable.');
    res.set({
      'Content-Type': 'image/webp',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.send(Buffer.from(image.bytes));
  });
  app.get('/api/public/sites/:slug', async (req, res) => {
    const admin = await isAdmin(req);
    if (admin) res.set('Cache-Control', 'no-store');
    res.json(
      (await service.publicSite(String(req.params.slug), campaignCode(req.query.c), admin)).site,
    );
  });
  app.post('/api/public/links/:id/embed', limiter(60000, 60), async (req, res) => {
    mustOrigin(req);
    const admin = await isAdmin(req);
    const { link, campaignId } = await service.publicLink(
      String(req.params.id),
      campaignCode(req.query.c),
      admin,
    );
    if (!link.embed) throw new AppError(400, 'Embedding is not enabled for this link.');
    if (!admin && !isBot(req.get('user-agent') || ''))
      await service.record(
        link.site_id,
        'click',
        link.id,
        'embed',
        req.get('referer') || '',
        campaignId,
      );
    res.json({ ok: true });
  });
  app.get('/r/:id', limiter(60000, 120), async (req, res) => {
    const admin = await isAdmin(req);
    const { link, campaignId } = await service.publicLink(
      String(req.params.id),
      campaignCode(req.query.c),
      admin,
    );
    res.set('Cache-Control', 'no-store');
    const target = link.kind === 'file' ? 'download' : 'outbound';
    if (!admin && req.method !== 'HEAD' && !isBot(req.get('user-agent') || ''))
      await service.record(
        link.site_id,
        'click',
        link.id,
        target,
        req.get('referer') || '',
        campaignId,
      );
    if (link.kind === 'file') return sendPdf(req, res, link.file_id, link.file_name);
    res.redirect(302, link.url);
  });
  app.get('/robots.txt', (_req, res) =>
    res
      .type('text/plain')
      .send('User-agent: *\nDisallow: /admin\nDisallow: /api\nDisallow: /mcp\n'),
  );
  app.get('/', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(landingHtml);
  });
  app.get(['/admin', '/admin/{*path}'], async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(await renderHtml(req));
  });
  // The caller mounts assets before this catch-all public route.
  // /<slug>.md, /<slug>/<code>.md, or Accept: text/markdown get the page as Markdown.
  // This relies on slugs and codes never containing a dot (slugSchema, randomSlug).
  const publicRoute = async (req: Request, res: Response) => {
    let slug = String(req.params.slug),
      code = campaignCode(req.params.code);
    const suffix = /\.md$/;
    const markdownPath = suffix.test(code ?? slug);
    if (markdownPath) {
      if (code) code = code.replace(suffix, '');
      else slug = slug.replace(suffix, '');
    }
    res.vary('Accept');
    const markdown = markdownPath || req.accepts(['html', 'text/markdown']) === 'text/markdown';
    const admin = await isAdmin(req);
    if (markdown) return markdownRoute(req, res, slug, code, admin);
    const { site, campaignId } = await service.publicSite(slug, code, admin);
    res.set('Cache-Control', 'no-store');
    const count = !admin && req.method !== 'HEAD' && !isBot(req.get('user-agent') || '');
    const referrer = req.get('referer') || '';
    if (count) await service.record(site.id, 'visit', null, 'page', referrer, campaignId);
    if (site.mode === 'redirect') {
      const link = site.links[0];
      if (!link || link.kind === 'section') throw new AppError(404, 'Destination unavailable.');
      if (count) await service.record(site.id, 'click', link.id, 'redirect', referrer, campaignId);
      if (link.kind === 'file') {
        const row = await service.link(link.id, admin);
        return sendPdf(req, res, row.file_id, row.file_name);
      }
      return res.redirect(302, link.url);
    }
    let html = await renderHtml(req);
    html = html.replace(/<title>.*?<\/title>/, '<title>' + escaped(site.title) + '</title>');
    // Lets the first paint use the page theme before the app has fetched the site.
    html = html.replace('<body>', `<body data-theme="${escaped(site.theme)}">`);
    if (!html.includes('name="robots"'))
      html = html.replace('</head>', `<meta name="robots" content="${robotsTag}"></head>`);
    const pageUrl = config.origin + '/' + slug + (site.campaign ? '/' + site.campaign : '');
    html = html.replace(
      '</head>',
      `<link rel="alternate" type="text/markdown" href="${escaped(pageUrl + '.md')}"></head>`,
    );
    const image = site.links.find((l) => l.imageUrl)?.imageUrl;
    html = html.replace(
      '</head>',
      `<meta property="og:title" content="${escaped(site.title)}"><meta property="og:description" content="${escaped(site.description)}"><meta property="og:url" content="${escaped(pageUrl)}">${image ? `<meta property="og:image" content="${escaped(image)}">` : ''}</head>`,
    );
    res.type('html').send(html);
  };
  // Agent reads count as visits (target "markdown"), bots included: agents are the
  // audience here. Link clicks are not seen, since the Markdown carries direct URLs.
  const markdownRoute = async (
    req: Request,
    res: Response,
    slug: string,
    code: string | undefined,
    admin: boolean,
  ) => {
    res.set('Cache-Control', 'no-store');
    const unavailable = () =>
      res
        .status(404)
        .type('text/markdown; charset=utf-8')
        .send('# Page unavailable\n\nThis link may have changed or been deactivated.\n');
    let found;
    try {
      found = await service.publicSite(slug, code, admin);
    } catch (e) {
      if (e instanceof AppError && e.status === 404) return unavailable();
      throw e;
    }
    const { site, campaignId } = found;
    if (site.mode === 'redirect' && (!site.links[0] || site.links[0].kind === 'section'))
      return unavailable();
    if (!admin && req.method !== 'HEAD')
      await service.record(
        site.id,
        'visit',
        null,
        'markdown',
        req.get('referer') || '',
        campaignId,
      );
    const base = config.origin + '/' + slug + (site.campaign ? '/' + site.campaign : '');
    res.type('text/markdown; charset=utf-8').send(siteMarkdown(site, config.origin, base));
  };
  const landingHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="robots" content="${robotsTag}"><title>Linkgarden</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f8fa;color:#444b5c;font-family:system-ui,sans-serif}h1{margin:0;padding:24px;font-size:1.25rem;font-weight:550;text-align:center}@media (prefers-color-scheme:dark){body{background:#15171c;color:#c9ceda}}</style></head><body><h1>Linkgarden</h1></body></html>`;
  const unavailableHtml =
    '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Page unavailable</title></head><body style="margin:0;background:#f7f8fa;font-family:system-ui;color:#444b5c"><main style="max-width:480px;margin:15vh auto;padding:30px"><h1>Page unavailable</h1><p>This link may have changed or been deactivated.</p></main></body></html>';
  const errorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return res.end();
    if (err instanceof z.ZodError)
      return res
        .status(400)
        .json({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (err instanceof AppError) {
      if (err.status === 404 && !req.path.startsWith('/api/') && req.path !== '/mcp')
        return res.status(404).type('html').send(unavailableHtml);
      return res.status(err.status).json({ error: err.message });
    }
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')
      return res.status(err.status || 400).json({ error: 'Invalid or oversized JSON body.' });
    console.error('Request failed:', err.code || err.name || 'unknown');
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  };
  return {
    app,
    service,
    readMcp,
    writeMcp,
    finish() {
      app.get(['/:slug', '/:slug/:code'], publicRoute);
      app.use((req, res) => res.status(404).type('html').send(unavailableHtml));
      app.use(errorHandler);
    },
  };
}
