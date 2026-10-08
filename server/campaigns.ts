import { randomUUID } from 'node:crypto';
import type { Queryable } from './db.js';
import type { SiteService } from './sites.js';
import { randomSlug } from './random.js';
import {
  campaignSchema,
  campaignPatchSchema,
  slugSchema,
  uuidSchema,
  type CampaignInput,
  type CampaignPatch,
} from '../shared/schemas.js';
import { AppError } from './errors.js';
function campaignDto(r: any) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    note: r.note,
    status: r.status,
    visits: Number(r.visits),
    clicks: Number(r.clicks),
    lastVisitAt: r.last_visit_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
// A campaign attributes traffic on the pages it is assigned to. Assignments are soft-removed
// so their counters stay in the analytics and come back when the campaign is reassigned.
export class CampaignService {
  constructor(private sites: SiteService) {}
  get db() {
    return this.sites.db;
  }
  url(slug: string, code: string) {
    return `${this.sites.origin}/${slug}/${code}`;
  }
  async list(status?: string, q = '') {
    const rows = (
      await this.db.query(
        `SELECT c.* FROM campaigns c WHERE ($1::text IS NULL OR status=$1) AND ($2='' OR name ILIKE $3 OR code ILIKE $3 OR note ILIKE $3) ORDER BY updated_at DESC`,
        [status || null, q, `%${q.replace(/[\\%_]/g, '\\$&')}%`],
      )
    ).rows;
    const pages = (
      await this.db.query(
        `SELECT sc.campaign_id,s.id,s.slug,s.title,s.status,s.campaign_only FROM site_campaigns sc JOIN sites s ON s.id=sc.site_id WHERE sc.removed_at IS NULL AND sc.campaign_id=ANY($1::uuid[]) ORDER BY s.title`,
        [rows.map((r) => r.id)],
      )
    ).rows;
    return rows.map((r) => ({
      ...campaignDto(r),
      pages: pages
        .filter((p) => p.campaign_id === r.id)
        .map((p) => ({
          id: p.id,
          slug: p.slug,
          title: p.title,
          status: p.status,
          campaignOnly: p.campaign_only,
          url: this.url(p.slug, r.code),
        })),
    }));
  }
  async get(id: string, tx: Queryable = this.db) {
    uuidSchema.parse(id);
    const r = (await tx.query('SELECT * FROM campaigns WHERE id=$1', [id])).rows[0];
    if (!r) throw new AppError(404, 'Campaign not found.');
    const pages = (
      await tx.query(
        `SELECT s.id,s.slug,s.title,s.mode,s.status,s.campaign_only,sc.visits,sc.clicks,sc.last_visit_at,sc.created_at,sc.removed_at FROM site_campaigns sc JOIN sites s ON s.id=sc.site_id WHERE sc.campaign_id=$1 ORDER BY sc.removed_at IS NOT NULL, s.title`,
        [id],
      )
    ).rows;
    const links = (
      await tx.query(
        `SELECT l.id,l.site_id,l.kind,l.title,l.url,f.filename,COALESCE(k.clicks,0) AS clicks FROM links l LEFT JOIN files f ON f.id=l.file_id LEFT JOIN campaign_link_clicks k ON k.link_id=l.id AND k.campaign_id=$1 WHERE l.site_id=ANY($2::uuid[]) AND l.kind<>'section' ORDER BY l.position`,
        [id, pages.map((p) => p.id)],
      )
    ).rows;
    return {
      ...campaignDto(r),
      pages: pages.map((p) => ({
        id: p.id,
        slug: p.slug,
        title: p.title,
        mode: p.mode,
        status: p.status,
        campaignOnly: p.campaign_only,
        assigned: !p.removed_at,
        url: this.url(p.slug, r.code),
        visits: Number(p.visits),
        clicks: Number(p.clicks),
        lastVisitAt: p.last_visit_at,
        assignedAt: p.created_at,
        removedAt: p.removed_at,
        links: links
          .filter((l) => l.site_id === p.id)
          .map((l) => ({
            id: l.id,
            kind: l.kind,
            title: l.title || l.filename || l.url,
            clicks: Number(l.clicks),
          })),
      })),
    };
  }
  async availableCode(tx: Queryable) {
    for (let i = 0; i < 20; i++) {
      const code = randomSlug();
      if (!slugSchema.safeParse(code).success) continue;
      if (!(await tx.query('SELECT id FROM campaigns WHERE code=$1', [code])).rows.length)
        return code;
    }
    throw new AppError(503, 'Could not allocate a campaign code. Please try again.');
  }
  // Pages can be named by ID or slug, so agents can pass whichever they have.
  async siteIds(tx: Queryable, refs: string[] = []) {
    const ids: string[] = [];
    for (const ref of new Set(refs)) {
      const row = (
        await tx.query(
          'SELECT id FROM sites WHERE id::text=$1 OR slug=$1 ORDER BY id::text=$1 DESC LIMIT 1',
          [ref],
        )
      ).rows[0];
      if (!row) throw new AppError(400, `Page not found: ${ref}`);
      if (!ids.includes(row.id)) ids.push(row.id);
    }
    return ids;
  }
  async assign(tx: Queryable, campaignId: string, siteIds: string[]) {
    for (const siteId of siteIds)
      await tx.query(
        'INSERT INTO site_campaigns(site_id,campaign_id) VALUES($1,$2) ON CONFLICT(site_id,campaign_id) DO UPDATE SET removed_at=NULL',
        [siteId, campaignId],
      );
  }
  async unassign(tx: Queryable, campaignId: string, siteIds: string[]) {
    await tx.query(
      'UPDATE site_campaigns SET removed_at=now() WHERE campaign_id=$1 AND site_id=ANY($2::uuid[]) AND removed_at IS NULL',
      [campaignId, siteIds],
    );
  }
  // Replaces the campaigns of one page; used by the page editor and create/update_site.
  async setForSite(tx: Queryable, siteId: string, campaignIds: string[]) {
    const ids = [...new Set(campaignIds)];
    const found = (await tx.query('SELECT id FROM campaigns WHERE id=ANY($1::uuid[])', [ids])).rows;
    if (found.length !== ids.length)
      throw new AppError(400, 'A campaign no longer exists. Reload the editor.');
    await tx.query(
      'UPDATE site_campaigns SET removed_at=now() WHERE site_id=$1 AND removed_at IS NULL AND NOT (campaign_id=ANY($2::uuid[]))',
      [siteId, ids],
    );
    for (const id of ids) await this.assign(tx, id, [siteId]);
  }
  // Active assignments of a page, for the editor, the overview copy menu, and get_site.
  async forSites(siteIds: string[], tx: Queryable = this.db) {
    return (
      await tx.query(
        `SELECT sc.site_id,c.id,c.code,c.name,c.status,s.slug FROM site_campaigns sc JOIN campaigns c ON c.id=sc.campaign_id JOIN sites s ON s.id=sc.site_id WHERE sc.site_id=ANY($1::uuid[]) AND sc.removed_at IS NULL ORDER BY c.name`,
        [siteIds],
      )
    ).rows.map((r) => ({
      siteId: r.site_id as string,
      id: r.id,
      code: r.code,
      name: r.name,
      status: r.status,
      url: this.url(r.slug, r.code),
    }));
  }
  async create(input: CampaignInput) {
    const data = campaignSchema.parse(input);
    const id = randomUUID();
    try {
      return await this.db.transaction(async (tx) => {
        const code = data.code || (await this.availableCode(tx));
        await tx.query('INSERT INTO campaigns(id,code,name,note,status) VALUES($1,$2,$3,$4,$5)', [
          id,
          code,
          data.name,
          data.note,
          data.status,
        ]);
        await this.assign(tx, id, await this.siteIds(tx, data.sites));
        return this.get(id, tx);
      });
    } catch (err) {
      this.handleConflict(err);
    }
  }
  async update(id: string, patch: CampaignPatch) {
    const data = campaignPatchSchema.parse(patch);
    try {
      return await this.db.transaction(async (tx) => {
        const current = (
          await tx.query('SELECT * FROM campaigns WHERE id=$1 FOR UPDATE', [uuidSchema.parse(id)])
        ).rows[0];
        if (!current) throw new AppError(404, 'Campaign not found.');
        await tx.query(
          'UPDATE campaigns SET name=$2,code=$3,note=$4,status=$5,updated_at=now() WHERE id=$1',
          [
            id,
            data.name ?? current.name,
            data.code ?? current.code,
            data.note ?? current.note,
            data.status ?? current.status,
          ],
        );
        if (data.sites) {
          const keep = await this.siteIds(tx, data.sites);
          await tx.query(
            'UPDATE site_campaigns SET removed_at=now() WHERE campaign_id=$1 AND removed_at IS NULL AND NOT (site_id=ANY($2::uuid[]))',
            [id, keep],
          );
          await this.assign(tx, id, keep);
        }
        await this.assign(tx, id, await this.siteIds(tx, data.addSites));
        await this.unassign(tx, id, await this.siteIds(tx, data.removeSites));
        return this.get(id, tx);
      });
    } catch (err) {
      this.handleConflict(err);
    }
  }
  handleConflict(err: unknown): never {
    if ((err as any)?.code === '23505')
      throw new AppError(409, 'This campaign code is already taken.');
    throw err;
  }
  async setState(id: string, status: 'active' | 'inactive' | 'archived') {
    await this.get(id);
    await this.db.query('UPDATE campaigns SET status=$2,updated_at=now() WHERE id=$1', [
      id,
      status,
    ]);
    return this.get(id);
  }
  async setNote(id: string, note: string) {
    return this.update(id, { note });
  }
  // The campaign that a public /<slug>/<code> URL attributes to, or null when the code is
  // unknown, not active, or not assigned to that page.
  async assigned(siteId: string, code: string | undefined) {
    if (!code || !slugSchema.safeParse(code).success) return null;
    const row = (
      await this.db.query(
        "SELECT c.id,c.code FROM campaigns c JOIN site_campaigns sc ON sc.campaign_id=c.id WHERE sc.site_id=$1 AND c.code=$2 AND c.status='active' AND sc.removed_at IS NULL",
        [siteId, code],
      )
    ).rows[0];
    return row ? { id: row.id as string, code: row.code as string } : null;
  }
  // Accepts a campaign ID or code, as agents may know either.
  async resolve(ref: string) {
    const row = (
      await this.db.query(
        'SELECT id FROM campaigns WHERE id::text=$1 OR code=$1 ORDER BY id::text=$1 DESC LIMIT 1',
        [ref],
      )
    ).rows[0];
    if (!row) throw new AppError(404, 'Campaign not found.');
    return row.id as string;
  }
  async analytics(id: string, days = 30, limit = 100, offset = 0) {
    const campaign = await this.get(id);
    const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const daily = (
      await this.db.query(
        'SELECT day,sum(visits) AS visits,sum(clicks) AS clicks FROM campaign_daily_metrics WHERE campaign_id=$1 AND day>=$2::date GROUP BY day ORDER BY day',
        [id, since],
      )
    ).rows.map((r) => ({
      day: new Date(r.day).toISOString().slice(0, 10),
      visits: Number(r.visits),
      clicks: Number(r.clicks),
    }));
    const events = (
      await this.db.query(
        'SELECT e.*,l.title AS link_title,f.filename AS file_name,s.slug,s.title AS site_title FROM events e JOIN sites s ON s.id=e.site_id LEFT JOIN links l ON l.id=e.link_id LEFT JOIN files f ON f.id=l.file_id WHERE e.campaign_id=$1 AND e.occurred_at>=$2::date ORDER BY e.occurred_at DESC,e.id LIMIT $3 OFFSET $4',
        [id, since, limit, offset],
      )
    ).rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      siteId: r.site_id,
      siteSlug: r.slug,
      siteTitle: r.site_title,
      linkId: r.link_id,
      title: r.link_title || r.file_name || null,
      target: r.target,
      referrer: r.referrer,
      at: r.occurred_at,
    }));
    const total = Number(
      (
        await this.db.query(
          'SELECT count(*) FROM events WHERE campaign_id=$1 AND occurred_at>=$2::date',
          [id, since],
        )
      ).rows[0].count,
    );
    return { campaign, daily, events, totalEvents: total, offset, days };
  }
}
