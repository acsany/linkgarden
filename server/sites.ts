import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Database, Queryable } from './db.js';
import type { FileStore } from './files.js';
import { siteSchema, slugSchema, uuidSchema, type SiteInput } from '../shared/schemas.js';
import { videoInfo } from '../shared/video.js';
import { iconRulesSchema, resolveIcon, type IconRule } from '../shared/icons.js';
import { PreviewStore } from './previews.js';
import { AppError } from './errors.js';
import { randomSlug } from './random.js';
import { CampaignService } from './campaigns.js';
function siteDto(r: any) {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description,
    note: r.note,
    mode: r.mode,
    status: r.status,
    theme: r.theme,
    campaignOnly: r.campaign_only,
    visits: Number(r.visits),
    agentVisits: Number(r.agent_visits),
    clicks: Number(r.clicks),
    statsResetAt: r.stats_reset_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function linkDto(r: any) {
  return {
    id: r.id,
    kind: r.kind,
    url: r.url,
    title: r.title,
    description: r.description,
    imageUrl: r.image_url,
    embed: r.embed,
    icon: r.icon,
    fullUrl: r.full_url,
    clicks: Number(r.clicks),
    embedUrl: r.embed ? videoInfo(r.url)?.embedUrl || null : null,
    ...(r.file_id
      ? { fileId: r.file_id, file: { filename: r.file_name, size: Number(r.file_size) } }
      : {}),
  };
}
// Files of links that are no longer saved are kept briefly for unsaved editor sessions.
const orphanAge = "interval '1 day'";
// Save responses list images that could not be stored, so editors and agents can react.
const withWarnings = <T extends object>(site: T, warnings: string[]) =>
  warnings.length ? { ...site, warnings } : site;
export class SiteService {
  campaigns: CampaignService;
  previews: PreviewStore;
  constructor(
    public db: Database,
    public files: FileStore,
    public origin = '',
  ) {
    this.campaigns = new CampaignService(this);
    this.previews = new PreviewStore(db, origin);
  }
  async list(status?: string, q = '') {
    const rows = (
      await this.db.query(
        `SELECT s.*, (SELECT count(*)::int FROM links WHERE site_id=s.id AND kind<>'section') AS link_count, (SELECT count(*)::int FROM links WHERE site_id=s.id AND kind='file') AS file_count FROM sites s WHERE ($1::text IS NULL OR status=$1) AND ($2='' OR title ILIKE $3 OR slug ILIKE $3 OR note ILIKE $3) ORDER BY updated_at DESC`,
        [status || null, q, `%${q.replace(/[\\%_]/g, '\\$&')}%`],
      )
    ).rows;
    const campaigns = await this.campaigns.forSites(rows.map((r) => r.id));
    return rows.map((r) => ({
      ...siteDto(r),
      linkCount: r.link_count,
      fileCount: r.file_count,
      campaigns: campaigns.filter((c) => c.siteId === r.id).map(({ siteId: _, ...c }) => c),
    }));
  }
  async get(id: string, tx: Queryable = this.db) {
    uuidSchema.parse(id);
    const r = (await tx.query('SELECT * FROM sites WHERE id=$1', [id])).rows[0];
    if (!r) throw new AppError(404, 'Site not found.');
    const links = (
      await tx.query(
        'SELECT l.*,f.filename AS file_name,f.size AS file_size FROM links l LEFT JOIN files f ON f.id=l.file_id WHERE l.site_id=$1 ORDER BY l.position',
        [id],
      )
    ).rows.map(linkDto);
    const campaigns = (await this.campaigns.forSites([id], tx)).map(({ siteId: _, ...c }) => c);
    return { ...siteDto(r), campaigns, links };
  }
  async iconRules(tx: Queryable = this.db): Promise<IconRule[]> {
    return (await tx.query('SELECT pattern,icon FROM icon_rules ORDER BY position'))
      .rows as IconRule[];
  }
  // Rules are saved as one ordered list; the first match wins.
  async setIconRules(input: IconRule[]) {
    const rules = iconRulesSchema.parse(input);
    return this.db.transaction(async (tx) => {
      await tx.query('LOCK TABLE icon_rules IN EXCLUSIVE MODE');
      await tx.query('DELETE FROM icon_rules');
      for (const [position, rule] of rules.entries())
        await tx.query('INSERT INTO icon_rules(id,pattern,icon,position) VALUES($1,$2,$3,$4)', [
          randomUUID(),
          rule.pattern,
          rule.icon,
          position,
        ]);
      return this.iconRules(tx);
    });
  }
  async availableSlug(tx: Queryable) {
    for (let i = 0; i < 20; i++) {
      const slug = randomSlug();
      if (!slugSchema.safeParse(slug).success) continue;
      if (!(await tx.query('SELECT id FROM sites WHERE slug=$1', [slug])).rows.length) return slug;
    }
    throw new AppError(503, 'Could not allocate a short URL. Please try again.');
  }
  async prepare(input: SiteInput, existing: any[] = []) {
    const result = siteSchema.parse(input);
    const warnings: string[] = [];
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, result.links.length) }, async () => {
        while (cursor < result.links.length) {
          const link = result.links[cursor++];
          if (link.kind !== 'link') continue;
          if (link.embed && !videoInfo(link.url))
            throw new AppError(400, 'Only YouTube and Vimeo videos can be embedded.');
          const old = existing.find((v) => v.id === link.id);
          if ((!old || old.url !== link.url) && (!link.title || !link.imageUrl)) {
            const metadata = await this.previews.preview(link.url);
            link.title ||= metadata.title;
            link.description ||= metadata.description;
            link.imageUrl ||= metadata.imageUrl;
          }
          // Custom titles stay out of the shared preview cache; only the image is stored.
          if (link.imageUrl && !this.previews.id(link.imageUrl)) {
            try {
              link.imageUrl = await this.previews.remote(link.imageUrl);
            } catch {
              // Keep the source for a later retry; public output never hotlinks it.
              warnings.push(
                `The image for "${link.title || link.url}" could not be saved, so the public page shows no image for it. Choose another image URL or import it.`,
              );
            }
          }
        }
      }),
    );
    return { data: result, warnings };
  }
  async create(input: SiteInput, preview = true) {
    const { data, warnings } = preview
      ? await this.prepare(input)
      : { data: siteSchema.parse(input), warnings: [] };
    const id = randomUUID();
    try {
      return await this.db.transaction(async (tx) => {
        await this.checkFiles(tx, data.links);
        const slug = data.slug || (await this.availableSlug(tx));
        await tx.query(
          'INSERT INTO sites(id,slug,title,description,note,mode,status,theme,campaign_only) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            id,
            slug,
            data.title,
            data.description,
            data.note,
            data.mode,
            data.status,
            data.theme,
            data.campaignOnly ?? false,
          ],
        );
        if (data.campaignIds) await this.campaigns.setForSite(tx, id, data.campaignIds);
        for (const [position, link] of data.links.entries())
          await this.insertLink(tx, id, link, position);
        return withWarnings(await this.get(id, tx), warnings);
      });
    } catch (err) {
      this.handleConflict(err);
    }
  }
  async checkFiles(tx: Queryable, links: SiteInput['links']) {
    const ids = links.flatMap((l) => (l.fileId ? [l.fileId] : []));
    if (!ids.length) return;
    const found = (await tx.query('SELECT id FROM files WHERE id=ANY($1::uuid[])', [ids])).rows;
    if (found.length !== new Set(ids).size)
      throw new AppError(400, 'An uploaded PDF is no longer available. Upload it again.');
  }
  async insertLink(
    tx: Queryable,
    siteId: string,
    link: SiteInput['links'][number],
    position: number,
  ) {
    await tx.query(
      'INSERT INTO links(id,site_id,kind,url,title,description,image_url,embed,position,file_id,icon,full_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [
        randomUUID(),
        siteId,
        link.kind,
        link.url,
        link.title,
        link.description,
        link.imageUrl,
        link.embed,
        position,
        link.fileId ?? null,
        link.icon ?? '',
        link.fullUrl ?? true,
      ],
    );
  }
  async update(id: string, input: SiteInput) {
    const previous = await this.get(id);
    const { data, warnings } = await this.prepare(input, previous.links);
    try {
      return await this.db.transaction(async (tx) => {
        await tx.query('SELECT id FROM sites WHERE id=$1 FOR UPDATE', [id]);
        const current = await this.get(id, tx);
        await this.checkFiles(tx, data.links);
        const owned = new Set(current.links.map((l) => l.id));
        if (data.links.some((l) => l.id && !owned.has(l.id)))
          throw new AppError(
            400,
            'A link does not belong to this site or was removed. Reload the editor.',
          );
        await tx.query(
          'UPDATE sites SET slug=$2,title=$3,description=$4,note=$5,mode=$6,status=$7,theme=$8,campaign_only=$9,updated_at=now() WHERE id=$1',
          [
            id,
            data.slug || current.slug,
            data.title,
            data.description,
            data.note,
            data.mode,
            data.status,
            data.theme,
            data.campaignOnly ?? current.campaignOnly,
          ],
        );
        if (data.campaignIds) await this.campaigns.setForSite(tx, id, data.campaignIds);
        const keep = data.links.flatMap((l) => (l.id ? [l.id] : []));
        await tx.query('DELETE FROM links WHERE site_id=$1 AND NOT (id=ANY($2::uuid[]))', [
          id,
          keep,
        ]);
        for (const [position, link] of data.links.entries()) {
          if (link.id)
            await tx.query(
              'UPDATE links SET kind=$3,url=$4,title=$5,description=$6,image_url=$7,embed=$8,position=$9,file_id=$10,icon=$11,full_url=$12 WHERE id=$1 AND site_id=$2',
              [
                link.id,
                id,
                link.kind,
                link.url,
                link.title,
                link.description,
                link.imageUrl,
                link.embed,
                position,
                link.fileId ?? null,
                link.icon ?? current.links.find((l) => l.id === link.id)?.icon ?? '',
                link.fullUrl ?? current.links.find((l) => l.id === link.id)?.fullUrl ?? true,
              ],
            );
          else await this.insertLink(tx, id, link, position);
        }
        return withWarnings(await this.get(id, tx), warnings);
      });
    } catch (err) {
      this.handleConflict(err);
    }
  }
  handleConflict(err: unknown): never {
    if ((err as any)?.code === '23505') throw new AppError(409, 'This short URL is already taken.');
    throw err;
  }
  // A duplicate starts fresh and inactive, so campaign assignments are not copied;
  // campaignOnly is, so a private page stays private.
  async duplicate(id: string, slug?: string) {
    const { campaigns: _, ...old } = await this.get(id);
    return this.create(
      {
        ...old,
        slug: slug ? slugSchema.parse(slug) : undefined,
        title: `${old.title.slice(0, 190)} (copy)`,
        status: 'inactive',
        links: old.links.map(({ id: _id, ...l }) => l),
      },
      false,
    );
  }
  async setState(id: string, status: 'active' | 'inactive' | 'archived') {
    await this.get(id);
    await this.db.query('UPDATE sites SET status=$2,updated_at=now() WHERE id=$1', [id, status]);
    return this.get(id);
  }
  async setNote(id: string, note: string) {
    await this.get(id);
    await this.db.query('UPDATE sites SET note=$2,updated_at=now() WHERE id=$1', [id, note]);
    return this.get(id);
  }
  // Resolves /<slug> and /<slug>/<code>. Unknown or unusable codes fall back to the
  // unattributed page, except on campaign-only pages, which then look nonexistent.
  // The signed-in admin (preview) also gets pages that are not active, with their status.
  async publicSite(slug: string, code?: string, preview = false) {
    const row = (
      await this.db.query(
        "SELECT id,campaign_only FROM sites WHERE slug=$1 AND ($2 OR status='active')",
        [slug, preview],
      )
    ).rows[0];
    if (!row) throw new AppError(404, 'This page is unavailable.');
    const campaign = await this.campaigns.assigned(row.id, code);
    if (!campaign && row.campaign_only) throw new AppError(404, 'This page is unavailable.');
    const s = await this.get(row.id);
    const rules = await this.iconRules();
    const images = await this.previews.publicImages(s.links);
    s.links.forEach((link, i) => (link.imageUrl = images[i]));
    const site = {
      id: s.id,
      slug: s.slug,
      title: s.title,
      description: s.description,
      mode: s.mode,
      theme: s.theme,
      // File items expose only their name and size; downloads go through /r/:id.
      links: s.links.map(
        ({
          id,
          kind,
          url,
          title,
          description,
          imageUrl,
          embed,
          embedUrl,
          icon,
          fullUrl,
          file,
        }) => ({
          id,
          kind,
          url,
          title,
          description,
          imageUrl,
          embed,
          embedUrl,
          // Resolved here so visitors get the icon without seeing the rules.
          icon: resolveIcon({ kind, url, icon }, rules),
          fullUrl,
          ...(file ? { file } : {}),
        }),
      ),
      // Only the public code, never the campaign's name or note.
      ...(campaign ? { campaign: campaign.code } : {}),
      ...(s.status !== 'active' ? { status: s.status } : {}),
    };
    return { site, campaignId: campaign?.id ?? null };
  }
  async record(
    siteId: string,
    kind: 'visit' | 'click',
    linkId: string | null,
    target: string,
    referrer: string,
    campaignId: string | null = null,
  ) {
    let domain = '';
    try {
      domain = new URL(referrer).origin.slice(0, 300);
    } catch {
      /* no referrer */
    }
    await this.db.transaction(async (tx) => {
      const row = (
        await tx.query("SELECT id FROM sites WHERE id=$1 AND status='active' FOR UPDATE", [siteId])
      ).rows[0];
      if (!row) throw new AppError(404, 'This page is unavailable.');
      if (
        linkId &&
        !(
          await tx.query("SELECT id FROM links WHERE id=$1 AND site_id=$2 AND kind<>'section'", [
            linkId,
            siteId,
          ])
        ).rows.length
      )
        throw new AppError(404, 'Link not found.');
      const visit = kind === 'visit' ? 1 : 0,
        click = kind === 'click' ? 1 : 0;
      await tx.query(
        'UPDATE sites SET visits=visits+$2,clicks=clicks+$3,agent_visits=agent_visits+$4 WHERE id=$1',
        [siteId, visit, click, kind === 'visit' && target === 'markdown' ? 1 : 0],
      );
      if (linkId) await tx.query('UPDATE links SET clicks=clicks+1 WHERE id=$1', [linkId]);
      // Rechecked here so a campaign deactivated or unassigned meanwhile is not credited.
      if (
        campaignId &&
        !(
          await tx.query(
            "SELECT 1 FROM site_campaigns sc JOIN campaigns c ON c.id=sc.campaign_id WHERE sc.site_id=$1 AND sc.campaign_id=$2 AND sc.removed_at IS NULL AND c.status='active'",
            [siteId, campaignId],
          )
        ).rows.length
      )
        campaignId = null;
      await tx.query(
        'INSERT INTO events(id,site_id,link_id,kind,target,referrer,campaign_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [randomUUID(), siteId, linkId, kind, target, domain, campaignId],
      );
      await tx.query(
        `INSERT INTO daily_metrics(site_id,day,visits,clicks) VALUES($1,(now() AT TIME ZONE 'UTC')::date,$2,$3) ON CONFLICT(site_id,day) DO UPDATE SET visits=daily_metrics.visits+$2,clicks=daily_metrics.clicks+$3`,
        [siteId, visit, click],
      );
      if (!campaignId) return;
      const counters =
        'visits=visits+$2::int,clicks=clicks+$3::int,last_visit_at=CASE WHEN $2::int>0 THEN now() ELSE last_visit_at END';
      await tx.query(`UPDATE campaigns SET ${counters} WHERE id=$1`, [campaignId, visit, click]);
      await tx.query(`UPDATE site_campaigns SET ${counters} WHERE campaign_id=$1 AND site_id=$4`, [
        campaignId,
        visit,
        click,
        siteId,
      ]);
      await tx.query(
        `INSERT INTO campaign_daily_metrics(site_id,campaign_id,day,visits,clicks) VALUES($1,$2,(now() AT TIME ZONE 'UTC')::date,$3,$4) ON CONFLICT(site_id,campaign_id,day) DO UPDATE SET visits=campaign_daily_metrics.visits+$3,clicks=campaign_daily_metrics.clicks+$4`,
        [siteId, campaignId, visit, click],
      );
      if (linkId)
        await tx.query(
          'INSERT INTO campaign_link_clicks(link_id,campaign_id,clicks) VALUES($1,$2,1) ON CONFLICT(link_id,campaign_id) DO UPDATE SET clicks=campaign_link_clicks.clicks+1',
          [linkId, campaignId],
        );
    });
  }
  async link(id: string, preview = false) {
    uuidSchema.parse(id);
    const row = (
      await this.db.query(
        "SELECT l.*,f.filename AS file_name,s.campaign_only FROM links l JOIN sites s ON s.id=l.site_id LEFT JOIN files f ON f.id=l.file_id WHERE l.id=$1 AND l.kind<>'section' AND ($2 OR s.status='active')",
        [id, preview],
      )
    ).rows[0];
    if (!row) throw new AppError(404, 'Link unavailable.');
    return row;
  }
  // A link click from a campaign page carries ?c=<code>; it is credited only when the
  // campaign is active and assigned to the link's page.
  async publicLink(id: string, code?: string, preview = false) {
    const link = await this.link(id, preview);
    const campaign = await this.campaigns.assigned(link.site_id, code);
    if (!campaign && link.campaign_only) throw new AppError(404, 'Link unavailable.');
    return { link, campaignId: campaign?.id ?? null };
  }
  // Starts the page's analytics over, e.g. after checking it before sending it out:
  // events, daily totals, and lifetime counters go, including the page's share of its
  // campaigns' totals. stats_reset_at records when counting restarted.
  async resetStats(id: string) {
    await this.get(id);
    await this.db.transaction(async (tx) => {
      // Locked like record() does, so no visit lands halfway through the reset.
      await tx.query('SELECT id FROM sites WHERE id=$1 FOR UPDATE', [id]);
      await tx.query(
        'UPDATE campaigns c SET visits=c.visits-sc.visits,clicks=c.clicks-sc.clicks FROM site_campaigns sc WHERE sc.campaign_id=c.id AND sc.site_id=$1',
        [id],
      );
      await tx.query(
        'UPDATE site_campaigns SET visits=0,clicks=0,last_visit_at=NULL WHERE site_id=$1',
        [id],
      );
      await tx.query(
        'UPDATE campaigns c SET last_visit_at=(SELECT max(last_visit_at) FROM site_campaigns WHERE campaign_id=c.id) WHERE id IN (SELECT campaign_id FROM site_campaigns WHERE site_id=$1)',
        [id],
      );
      await tx.query('DELETE FROM campaign_daily_metrics WHERE site_id=$1', [id]);
      await tx.query(
        'DELETE FROM campaign_link_clicks WHERE link_id IN (SELECT id FROM links WHERE site_id=$1)',
        [id],
      );
      await tx.query('DELETE FROM daily_metrics WHERE site_id=$1', [id]);
      await tx.query('DELETE FROM events WHERE site_id=$1', [id]);
      await tx.query('UPDATE links SET clicks=0 WHERE site_id=$1', [id]);
      await tx.query(
        'UPDATE sites SET visits=0,clicks=0,agent_visits=0,stats_reset_at=now() WHERE id=$1',
        [id],
      );
    });
    return this.get(id);
  }
  // With a campaign (ID or code), daily totals and events are limited to its traffic.
  async analytics(id: string, days = 30, limit = 100, offset = 0, campaign?: string) {
    const site = await this.get(id);
    const campaignId = campaign ? await this.campaigns.resolve(campaign) : null;
    const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const daily = (
      await this.db.query(
        campaignId
          ? 'SELECT day,visits,clicks FROM campaign_daily_metrics WHERE site_id=$1 AND day>=$2::date AND campaign_id=$3 ORDER BY day'
          : 'SELECT day,visits,clicks FROM daily_metrics WHERE site_id=$1 AND day>=$2::date ORDER BY day',
        campaignId ? [id, since, campaignId] : [id, since],
      )
    ).rows.map((r) => ({
      day: new Date(r.day).toISOString().slice(0, 10),
      visits: Number(r.visits),
      clicks: Number(r.clicks),
    }));
    const filter =
      'e.site_id=$1 AND e.occurred_at>=$2::date AND ($3::uuid IS NULL OR e.campaign_id=$3)';
    const events = (
      await this.db.query(
        `SELECT e.*,l.title AS link_title,c.code AS campaign_code,c.name AS campaign_name FROM events e LEFT JOIN links l ON l.id=e.link_id LEFT JOIN campaigns c ON c.id=e.campaign_id WHERE ${filter} ORDER BY e.occurred_at DESC,e.id LIMIT $4 OFFSET $5`,
        [id, since, campaignId, limit, offset],
      )
    ).rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      linkId: r.link_id,
      title: r.link_title,
      target: r.target,
      referrer: r.referrer,
      campaign: r.campaign_id
        ? { id: r.campaign_id, code: r.campaign_code, name: r.campaign_name }
        : null,
      at: r.occurred_at,
    }));
    const total = Number(
      (
        await this.db.query(`SELECT count(*) FROM events e WHERE ${filter}`, [
          id,
          since,
          campaignId,
        ])
      ).rows[0].count,
    );
    // Markdown reads in this period; events cover the longest period (365 days).
    const agentVisits = Number(
      (
        await this.db.query(
          `SELECT count(*) FROM events e WHERE ${filter} AND e.kind='visit' AND e.target='markdown'`,
          [id, since, campaignId],
        )
      ).rows[0].count,
    );
    return {
      site,
      daily,
      agentVisits,
      events,
      totalEvents: total,
      offset,
      days,
      campaign: campaignId,
      ...(await this.campaignBreakdown(site)),
    };
  }
  // Lifetime visits and clicks per campaign, including removed assignments, plus the
  // traffic that came through the base URL or unusable codes.
  async campaignBreakdown(site: { id: string; visits: number; clicks: number }) {
    const campaigns = (
      await this.db.query(
        'SELECT c.id,c.code,c.name,c.status,sc.visits,sc.clicks,sc.last_visit_at,sc.removed_at FROM site_campaigns sc JOIN campaigns c ON c.id=sc.campaign_id WHERE sc.site_id=$1 ORDER BY sc.removed_at IS NOT NULL,sc.last_visit_at DESC NULLS LAST,c.name',
        [site.id],
      )
    ).rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      status: r.status,
      assigned: !r.removed_at,
      visits: Number(r.visits),
      clicks: Number(r.clicks),
      lastVisitAt: r.last_visit_at,
    }));
    const last = (
      await this.db.query(
        "SELECT max(occurred_at) AS at FROM events WHERE site_id=$1 AND kind='visit' AND campaign_id IS NULL",
        [site.id],
      )
    ).rows[0].at;
    return {
      campaigns,
      unattributed: {
        visits: site.visits - campaigns.reduce((n, c) => n + c.visits, 0),
        clicks: site.clicks - campaigns.reduce((n, c) => n + c.clicks, 0),
        lastVisitAt: last,
      },
    };
  }
  async uploadPdf(body: Readable, name: string, maxBytes: number) {
    const f = await this.files.save(body, name, maxBytes);
    // Same bytes under the same name reuse the stored file; refreshing created_at
    // keeps a day-old unused upload from being cleaned up before it is attached.
    const existing = (
      await this.db.query(
        'UPDATE files SET created_at=now() WHERE id=(SELECT id FROM files WHERE sha256=$1 AND filename=$2 ORDER BY created_at LIMIT 1) RETURNING id,filename,size',
        [f.sha256, f.filename],
      )
    ).rows[0];
    if (existing) {
      await this.files.remove(f.id);
      return {
        id: existing.id as string,
        filename: existing.filename as string,
        size: Number(existing.size),
      };
    }
    try {
      await this.db.query('INSERT INTO files(id,filename,size,sha256) VALUES($1,$2,$3,$4)', [
        f.id,
        f.filename,
        f.size,
        f.sha256,
      ]);
    } catch (err) {
      await this.files.remove(f.id);
      throw err;
    }
    return { id: f.id, filename: f.filename, size: f.size };
  }
  async file(id: string) {
    uuidSchema.parse(id);
    const row = (await this.db.query('SELECT id,filename FROM files WHERE id=$1', [id])).rows[0];
    if (!row) throw new AppError(404, 'File not found.');
    return row as { id: string; filename: string };
  }
  async cleanup() {
    await this.db.query("DELETE FROM events WHERE occurred_at < now() - interval '365 days'");
    await this.db.query('DELETE FROM sessions WHERE expires_at<=now()');
    await this.db.query('DELETE FROM agent_tokens WHERE expires_at<=now()');
    // Duplicated pages share a stored file, so it goes only once no link uses it.
    const removed = (
      await this.db.query(
        `DELETE FROM files f WHERE created_at < now() - ${orphanAge} AND NOT EXISTS (SELECT 1 FROM links WHERE file_id=f.id) RETURNING id`,
      )
    ).rows;
    for (const r of removed) await this.files.remove(r.id);
    const known = new Set((await this.db.query('SELECT id FROM files')).rows.map((r) => r.id));
    await this.files.sweep(known, new Date(Date.now() - 86400000));
    await this.previews.cleanup();
  }
}
