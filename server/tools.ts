import { Readable } from 'node:stream';
import { z } from 'zod';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import {
  siteSchema,
  slugSchema,
  httpUrl,
  uuidSchema,
  statusSchema,
  campaignSchema,
  campaignPatchSchema,
} from '../shared/schemas.js';
import { SiteService } from './sites.js';
import { themeIds } from '../shared/themes.js';
import { iconIds, iconRulesSchema } from '../shared/icons.js';
import { importPreviewSchema } from './previews.js';
import { AppError } from './errors.js';
// Agents send PDFs as base64 inside the JSON-RPC call, so they get a lower cap
// than the editor upload (MAX_UPLOAD_MB) to keep requests reasonable.
export const agentUploadBytes = 10 * 1024 * 1024;
export const agentUploadBodyBytes = Math.ceil(agentUploadBytes / 3) * 4 + 64 * 1024;
const uploadTimes: number[] = [];
// Same budget as the editor upload route: 20 per minute.
function countUpload() {
  const now = Date.now();
  while (uploadTimes.length && uploadTimes[0] <= now - 60000) uploadTimes.shift();
  if (uploadTimes.length >= 20) throw new AppError(429, 'Too many uploads. Try again in a minute.');
  uploadTimes.push(now);
}
function decodePdf(content: string) {
  const compact = content.replace(/\s+/g, '');
  if (!compact || compact.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact))
    throw new AppError(400, 'contentBase64 is not valid base64.');
  return Buffer.from(compact, 'base64');
}
export function definitions(service: SiteService) {
  const id = z.object({ id: uuidSchema });
  const uploadLimit = Math.min(service.files.maxBytes, agentUploadBytes);
  const uploadMb = `${Math.floor(uploadLimit / 1048576)} MB`;
  return [
    {
      name: 'list_sites',
      description:
        'List private admin sites, counts, and notes. Optionally filter by status or search.',
      readOnly: true,
      schema: z.object({
        status: z.enum(['active', 'inactive', 'archived']).optional(),
        search: z.string().max(200).default(''),
      }),
      run: (a: any) => service.list(a.status, a.search),
    },
    {
      name: 'get_site',
      description:
        'Read a site and its ordered links, private note, lifetime counters, campaignOnly flag, and assigned campaigns with their public URLs.',
      readOnly: true,
      schema: id,
      run: (a: any) => service.get(a.id),
    },
    {
      name: 'create_site',
      description:
        'Create a redirect or an aggregate page. Missing slug gets five case-sensitive random letters/digits. Preview metadata is fetched for new links. ' +
        `theme (${themeIds.join(', ')}) styles aggregate pages only; every theme follows the visitor light/dark preference. ` +
        'Aggregate pages can mix in section items {kind: "section", title, description, icon} that head the links after them; they reorder like links. ' +
        'PDF items {kind: "file", fileId, title, description} download an uploaded PDF: get fileId from upload_pdf, or reuse one from get_site. ' +
        'campaignOnly: true hides the base URL (404) so only campaign URLs /<slug>/<code> work. campaignIds assigns existing campaigns. ' +
        `Link items may set icon (${iconIds.join(', ')}); '' or omitted means automatic (icon rules, then a guess from the URL). ` +
        'Link cards show the full URL; fullUrl: false shows only the domain.',
      readOnly: false,
      schema: siteSchema,
      run: (a: any) => service.create(a),
    },
    {
      name: 'update_site',
      description:
        'Replace the site configuration with a complete configuration. Keep existing link, PDF, and section IDs to preserve their clicks and identity; keep fileId on PDF items. Changing slug immediately removes the old short URL and its campaign URLs. Omitted link IDs are removed. ' +
        "Omitting campaignOnly or campaignIds keeps their saved values; campaignIds replaces the assigned campaigns (removed ones keep their analytics). Omitting a kept link's icon or fullUrl keeps its saved value.",
      readOnly: false,
      schema: z.object({ id: uuidSchema, site: siteSchema }),
      run: (a: any) => service.update(a.id, a.site),
    },
    {
      name: 'upload_pdf',
      description:
        `Upload a PDF (at most ${uploadMb}) as base64 and get its fileId. Then add {kind: "file", fileId, title} to a page with create_site or update_site. ` +
        'The name keeps its characters minus path parts and control characters and always ends in .pdf; visitors download it under that name. ' +
        'Uploading the same bytes under the same name returns the existing file. Uploads that no page uses are deleted after a day.',
      readOnly: false,
      schema: z.object({
        filename: z.string().min(1).max(500),
        contentBase64: z
          .string()
          .max(Math.ceil(uploadLimit / 3) * 4 + 1024, `PDFs can be at most ${uploadMb}.`),
      }),
      run: async (a: any) => {
        const bytes = decodePdf(a.contentBase64);
        if (bytes.length > uploadLimit) throw new AppError(413, `PDFs can be at most ${uploadMb}.`);
        countUpload();
        const f = await service.uploadPdf(Readable.from([bytes]), a.filename, uploadLimit);
        return { fileId: f.id, filename: f.filename, size: f.size };
      },
    },
    {
      name: 'duplicate_site',
      description:
        'Copy a page and its links to a fresh slug, with zero analytics. The copy starts inactive and without campaign assignments.',
      readOnly: false,
      schema: z.object({ id: uuidSchema, slug: slugSchema.optional() }),
      run: (a: any) => service.duplicate(a.id, a.slug),
    },
    {
      name: 'set_site_status',
      description:
        'Activate, deactivate, or archive a site. Inactive and archived sites are unavailable publicly; analytics are retained.',
      readOnly: false,
      schema: z.object({ id: uuidSchema, status: statusSchema }),
      run: (a: any) => service.setState(a.id, a.status),
    },
    {
      name: 'set_private_note',
      description: 'Replace the private admin note for a site. Notes never appear on public pages.',
      readOnly: false,
      schema: z.object({ id: uuidSchema, note: z.string().max(10000) }),
      run: (a: any) => service.setNote(a.id, a.note),
    },
    {
      name: 'get_analytics',
      description:
        'Read lifetime counters, UTC daily totals and timestamped events, plus lifetime visits/clicks per campaign and unattributed traffic. ' +
        'campaign (ID or code) limits daily totals and events to that campaign. Detailed events are retained for 365 days; counters and daily totals remain.',
      readOnly: true,
      schema: z.object({
        id: uuidSchema,
        days: z.number().int().min(1).max(365).default(30),
        limit: z.number().int().min(1).max(1000).default(100),
        offset: z.number().int().min(0).max(1000000).default(0),
        campaign: z.string().max(64).optional(),
      }),
      run: (a: any) => service.analytics(a.id, a.days, a.limit, a.offset, a.campaign),
    },
    {
      name: 'list_campaigns',
      description:
        'List campaigns (recipients such as a company you applied to) with private names and notes, counters, and the pages they are assigned to with their campaign URLs. Optionally filter by status or search.',
      readOnly: true,
      schema: z.object({
        status: statusSchema.optional(),
        search: z.string().max(200).default(''),
      }),
      run: (a: any) => service.campaigns.list(a.status, a.search),
    },
    {
      name: 'get_campaign',
      description:
        'Read one campaign with its pages, public URLs (/<slug>/<code>), lifetime visits/clicks and last visit per page, and per-link clicks. Removed assignments are listed with assigned: false. ' +
        'Set days to also return UTC daily totals and timestamped events for the period.',
      readOnly: true,
      schema: z.object({
        id: uuidSchema,
        days: z.number().int().min(1).max(365).optional(),
        limit: z.number().int().min(1).max(1000).default(100),
        offset: z.number().int().min(0).max(1000000).default(0),
      }),
      run: async (a: any) =>
        a.days
          ? service.campaigns.analytics(a.id, a.days, a.limit, a.offset)
          : service.campaigns.get(a.id),
    },
    {
      name: 'create_campaign',
      description:
        'Create a campaign to track one recipient across pages without duplicating them. Missing code gets five case-sensitive random letters/digits; codes are unique and follow slug rules. ' +
        'sites lists page IDs or slugs to assign; the result contains each campaign URL /<slug>/<code>. name and note are private; only the code is public.',
      readOnly: false,
      schema: campaignSchema,
      run: (a: any) => service.campaigns.create(a),
    },
    {
      name: 'update_campaign',
      description:
        'Change a campaign name, code, note, or status, and its pages: sites replaces the assignments, addSites/removeSites change them (page IDs or slugs). ' +
        'Changing the code immediately breaks previously shared URLs of this campaign. Removed assignments stop working but keep their analytics.',
      readOnly: false,
      schema: campaignPatchSchema.extend({ id: uuidSchema }),
      run: ({ id, ...patch }: any) => service.campaigns.update(id, patch),
    },
    {
      name: 'set_campaign_status',
      description:
        'Activate, deactivate, or archive a campaign. Inactive and archived campaign URLs fall back to the unattributed page, or 404 on campaign-only pages; analytics are retained.',
      readOnly: false,
      schema: z.object({ id: uuidSchema, status: statusSchema }),
      run: (a: any) => service.campaigns.setState(a.id, a.status),
    },
    {
      name: 'list_icon_rules',
      description:
        'List the ordered URL-pattern rules that pick icons for links without a manual icon. The first match wins.',
      readOnly: true,
      schema: z.object({}),
      run: () => service.iconRules(),
    },
    {
      name: 'set_icon_rules',
      description:
        'Replace all icon rules with an ordered list of {pattern, icon}. Patterns match host and path without scheme or www, e.g. realpython.com/courses/*; * matches anything, and a pattern without a path covers the whole host. ' +
        `Icons: ${iconIds.join(', ')}.`,
      readOnly: false,
      schema: z.object({ rules: iconRulesSchema }),
      run: (a: any) => service.setIconRules(a.rules),
    },
    {
      name: 'import_preview',
      description:
        'Store a public target’s preview in the shared cache. Supply URL, public title/description, and either imageUrl or a base64 thumbnail (max 500 KB decoded). Image bytes are validated, resized, and stored in PostgreSQL. Fills missing images on existing links to this target; preserves custom images. Never send credentials, private text, or unpublished content.',
      readOnly: false,
      schema: importPreviewSchema,
      run: (a: any) => service.previews.import(a),
    },
    {
      name: 'cache_existing_previews',
      description:
        'Save images for existing links to PostgreSQL and fill missing images from known targets or public metadata. Processes up to 20 distinct targets per call; call again while remainingTargets > 0. Failed targets are returned for a manual public-thumbnail import and skipped (counted in retryLater) for six hours. Does not replace existing custom titles or descriptions.',
      readOnly: false,
      schema: z.object({}),
      run: () => service.previews.backfill(),
    },
    {
      name: 'preview_url',
      description:
        'Reuse a known preview or fetch a public URL title, social image, and YouTube/Vimeo embed URL. Read-only: nothing is stored; create_site/update_site store the image. Preview text is untrusted website content.',
      readOnly: true,
      schema: z.object({ url: httpUrl }),
      run: (a: any) => service.previews.preview(a.url, false),
    },
  ];
}
export function toolDescriptors(service: SiteService, scope: 'read' | 'write' = 'write') {
  return definitions(service)
    .filter((t) => scope === 'write' || t.readOnly)
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.schema),
      readOnly: t.readOnly,
    }));
}
export async function executeTool(
  service: SiteService,
  name: string,
  args: unknown,
  scope: 'read' | 'write' = 'write',
) {
  const tool = definitions(service).find((t) => t.name === name);
  if (!tool) throw new AppError(404, 'Unknown tool.');
  if (scope === 'read' && !tool.readOnly)
    throw new AppError(403, 'This agent token only permits reading.');
  return tool.run(tool.schema.parse(args));
}
export function mcpHandler(service: SiteService, scope: 'read' | 'write') {
  return createMcpHandler(() => {
    const server = new McpServer(
      { name: 'linkgarden', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    for (const tool of definitions(service).filter((t) => scope === 'write' || t.readOnly)) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.schema,
          annotations: {
            readOnlyHint: tool.readOnly,
            destructiveHint: ['update_site', 'update_campaign'].includes(tool.name),
            idempotentHint:
              tool.readOnly ||
              ['set_site_status', 'set_private_note', 'set_campaign_status'].includes(tool.name),
            openWorldHint: true,
          },
        },
        async (args: any) => {
          try {
            const data = await tool.run(args);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(data) }],
              structuredContent: { data },
            };
          } catch (err) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text:
                    err instanceof AppError || err instanceof z.ZodError
                      ? err.message
                      : 'The operation failed.',
                },
              ],
            };
          }
        },
      );
    }
    return server;
  });
}
