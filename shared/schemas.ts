import { z } from 'zod';
import { themeIds } from './themes.js';
import { iconIds } from './icons.js';
export const reservedSlugs = new Set([
  'admin',
  'api',
  'mcp',
  'r',
  'health',
  'assets',
  'icons',
  'favicon.ico',
  'robots.txt',
]);
// No dots, ever: /<slug>.md and /<slug>/<code>.md serve pages as Markdown.
export const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, digits, hyphens, or underscores.')
  .refine((v) => !reservedSlugs.has(v.toLowerCase()), 'This URL is reserved.');
export const httpUrl = z
  .string()
  .max(2048)
  .url()
  .refine((v) => {
    try {
      const u = new URL(v);
      return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'Use a full HTTP or HTTPS URL without credentials.');
// A page item is a link, an uploaded PDF, or a section heading that groups the items
// after it. All share one ordered list so they reorder the same way.
export const linkSchema = z
  .object({
    id: z.uuid().optional(),
    kind: z.enum(['link', 'section', 'file']).default('link'),
    url: z.union([httpUrl, z.literal('')]).default(''),
    fileId: z.uuid().optional(),
    title: z.string().max(200).default(''),
    description: z.string().max(1000).default(''),
    imageUrl: z.union([httpUrl, z.literal('')]).default(''),
    embed: z.boolean().default(false),
    // A manual icon choice; '' means automatic. Optional so updates that omit it keep it.
    icon: z.union([z.enum(iconIds), z.literal('')]).optional(),
    // Show the whole URL on the card (default) or only its domain. Optional like icon.
    fullUrl: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'link' && !v.url)
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'Links need a destination URL.' });
    if (v.kind === 'section') {
      if (!v.title.trim())
        ctx.addIssue({ code: 'custom', path: ['title'], message: 'Sections need a headline.' });
      if (v.url || v.imageUrl || v.embed)
        ctx.addIssue({
          code: 'custom',
          path: ['kind'],
          message: 'Sections only have a headline, a description, and an icon.',
        });
    }
    if (v.kind === 'file') {
      if (!v.fileId)
        ctx.addIssue({ code: 'custom', path: ['fileId'], message: 'Upload a PDF file.' });
      if (v.url || v.imageUrl || v.embed || v.icon)
        ctx.addIssue({
          code: 'custom',
          path: ['kind'],
          message: 'PDF items only have a file, a title, and a description.',
        });
    } else if (v.fileId)
      ctx.addIssue({ code: 'custom', path: ['fileId'], message: 'Only PDF items have a file.' });
  });
// Links and PDFs are click targets; sections are not.
export const isTarget = (l: { kind: string }) => l.kind !== 'section';
export const statusSchema = z.enum(['active', 'inactive', 'archived']);
export const siteSchema = z
  .object({
    slug: slugSchema.optional(),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(2000).default(''),
    note: z.string().max(10000).default(''),
    mode: z.enum(['redirect', 'aggregate']).default('aggregate'),
    status: statusSchema.default('active'),
    theme: z.preprocess((v) => (v === 'cv-sans' ? 'cv' : v), z.enum(themeIds)).default('default'),
    // Both are optional so a full update that omits them keeps the saved values;
    // dropping campaignOnly by accident would make a private page public.
    campaignOnly: z.boolean().optional(),
    campaignIds: z.array(z.uuid()).max(100).optional(),
    links: z.array(linkSchema).min(1).max(100),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'redirect' && (v.links.length !== 1 || !isTarget(v.links[0])))
      ctx.addIssue({
        code: 'custom',
        path: ['links'],
        message: 'Redirects require exactly one destination.',
      });
    if (!v.links.some(isTarget))
      ctx.addIssue({ code: 'custom', path: ['links'], message: 'Add at least one link or PDF.' });
    const ids = v.links.flatMap((l) => (l.id ? [l.id] : []));
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', path: ['links'], message: 'Link IDs must be unique.' });
  });
export type SiteInput = z.infer<typeof siteSchema>;
// Pages are referenced by ID or by slug.
const siteRef = z.string().trim().min(1).max(64);
// A campaign is a recipient. Its code is the public URL segment after a page slug
// (/cv/<code>); name and note stay private.
export const campaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  code: slugSchema.optional(),
  note: z.string().max(10000).default(''),
  status: statusSchema.default('active'),
  sites: z.array(siteRef).max(100).optional(),
});
export type CampaignInput = z.infer<typeof campaignSchema>;
export const campaignPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  code: slugSchema.optional(),
  note: z.string().max(10000).optional(),
  status: statusSchema.optional(),
  sites: z.array(siteRef).max(100).optional(),
  addSites: z.array(siteRef).max(100).optional(),
  removeSites: z.array(siteRef).max(100).optional(),
});
export type CampaignPatch = z.infer<typeof campaignPatchSchema>;
export const uuidSchema = z.uuid();
