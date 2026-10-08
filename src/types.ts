import type { ThemeId } from '../shared/themes';
export interface Link {
  id?: string;
  kind: 'link' | 'section' | 'file';
  url: string;
  fileId?: string;
  file?: { filename: string; size: number };
  title: string;
  description: string;
  imageUrl: string;
  embed: boolean;
  // A manual choice in the editor ('' = automatic); public pages get the resolved icon.
  icon?: string;
  // Show the whole URL on the card, or only the domain when false.
  fullUrl?: boolean;
  embedUrl?: string | null;
  clicks?: number;
}
export type Status = 'active' | 'inactive' | 'archived';
// An active assignment of a campaign to a page, with its public URL.
export interface CampaignRef {
  id: string;
  code: string;
  name: string;
  status: Status;
  url: string;
}
export interface Site {
  id: string;
  slug: string;
  title: string;
  description: string;
  note: string;
  mode: 'redirect' | 'aggregate';
  status: Status;
  theme: ThemeId;
  campaignOnly: boolean;
  campaigns: CampaignRef[];
  visits: number;
  agentVisits: number;
  clicks: number;
  statsResetAt: string | null;
  createdAt: string;
  updatedAt: string;
  links: Link[];
  linkCount?: number;
  fileCount?: number;
}
export interface Analytics {
  site: Site;
  daily: { day: string; visits: number; clicks: number }[];
  agentVisits: number;
  events: {
    id: string;
    kind: string;
    title: string | null;
    linkId: string | null;
    target: string;
    referrer: string;
    campaign: { id: string; code: string; name: string } | null;
    at: string;
  }[];
  totalEvents: number;
  offset: number;
  days: number;
  campaign: string | null;
  campaigns: (Omit<CampaignRef, 'url'> & {
    assigned: boolean;
    visits: number;
    clicks: number;
    lastVisitAt: string | null;
  })[];
  unattributed: { visits: number; clicks: number; lastVisitAt: string | null };
}
export interface CampaignPage {
  id: string;
  slug: string;
  title: string;
  mode: Site['mode'];
  status: Status;
  campaignOnly: boolean;
  assigned: boolean;
  url: string;
  visits: number;
  clicks: number;
  lastVisitAt: string | null;
  links: { id: string; kind: Link['kind']; title: string; clicks: number }[];
}
export interface Campaign {
  id: string;
  code: string;
  name: string;
  note: string;
  status: Status;
  visits: number;
  clicks: number;
  lastVisitAt: string | null;
  createdAt: string;
  updatedAt: string;
  pages: CampaignPage[];
}
export interface CampaignAnalytics {
  campaign: Campaign;
  daily: { day: string; visits: number; clicks: number }[];
  events: {
    id: string;
    kind: string;
    siteSlug: string;
    siteTitle: string;
    title: string | null;
    target: string;
    referrer: string;
    at: string;
  }[];
  totalEvents: number;
  offset: number;
  days: number;
}
