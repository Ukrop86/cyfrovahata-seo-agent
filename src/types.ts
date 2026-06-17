export type SeoIssueType =
  | 'missing_title'
  | 'short_title'
  | 'long_title'
  | 'missing_description'
  | 'short_description'
  | 'long_description'
  | 'missing_h1'
  | 'duplicate_h1'
  | 'low_text'
  | 'noindex'
  | 'canonical_mismatch';

export type ProposalStatus =
  | 'pending'
  | 'applied'
  | 'failed'
  | 'invalid'
  | 'applied_monitoring'
  | 'waiting_for_indexing'
  | 'indexed_collecting_data'
  | 'ready_for_analysis'
  | 'improved'
  | 'unchanged'
  | 'declined';

export type MonitoringStatus =
  | 'waiting_for_indexing'
  | 'indexed_collecting_data'
  | 'ready_for_analysis'
  | 'improved'
  | 'unchanged'
  | 'declined';

export const MONITORING_STATUSES: MonitoringStatus[] = [
  'waiting_for_indexing',
  'indexed_collecting_data',
  'ready_for_analysis',
  'improved',
  'unchanged',
  'declined',
];

export interface SeoPageData {
  url: string;
  title: string | null;
  description: string | null;
  h1: string[];
  h2: string[];
  canonical: string | null;
  robots: string | null;
  wordCount: number;
  issues: SeoIssueType[];
  scannedAt: string;
}

export interface SeoProposalBlockItem {
  question: string;
  answer: string;
}

export interface SeoProposalHtmlBlock {
  tag: string;
  className?: string;
  heading?: string;
  paragraphs?: string[];
  items?: SeoProposalBlockItem[];
  text?: string;
  question?: string;
  answer?: string;
  internalLinks?: Array<{ text: string; url: string }>;
  title?: string;
  description?: string;
}

export interface SeoProposal {
  id?: number;
  pageUrl: string;
  type: string;
  title: string;
  priority: number | string;
  reason: string;
  exactAction: string;
  htmlBlocks?: SeoProposalHtmlBlock[];
  proposedHtml?: string;
  status: ProposalStatus;
  appliedAt?: string;
  oldContentHash?: string;
  newContentHash?: string;
  monitoringUntil?: string;
  monitoringStatus?: MonitoringStatus;
  baselineClicks?: number;
  baselineImpressions?: number;
  baselineCtr?: number;
  baselinePosition?: number;
  monitoringSource?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface MonitoringRecord {
  id?: number;
  proposalId: number;
  pageUrl: string;
  status: MonitoringStatus;
  createdAt?: string;
  updatedAt?: string;
}

export interface GscAnalyticsRecord {
  id?: number;
  pageUrl: string;
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface GscQueryRecord {
  id?: number;
  pageUrl: string;
  query: string;
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  createdAt?: string;
  updatedAt?: string;
}

export type SeoChangeType =
  | 'title_update'
  | 'meta_description_update'
  | 'content_block_added'
  | 'faq_added'
  | 'seo_block_added'
  | 'internal_links_added'
  | 'article_added'
  | 'manual_change'
  | 'technical_fix';

export interface SeoChangeLogEntry {
  id?: number;
  pageUrl: string;
  changeType: SeoChangeType | string;
  title: string;
  description: string;
  relatedProposalId?: number;
  beforeSnapshot?: string;
  afterSnapshot?: string;
  appliedAt: string;
  createdAt?: string;
}

export type SeoInsightType =
  | 'growth'
  | 'decline'
  | 'stable'
  | 'not_enough_data'
  | 'waiting_for_result'
  | 'opportunity'
  | 'cannibalization_risk'
  | 'ctr_problem'
  | 'position_problem'
  | 'content_fatigue';

export type SeoInsightStatus = 'new' | 'reviewed' | 'ignored' | 'action_planned' | 'action_done';

export interface SeoAnalysisInsight {
  id?: number;
  pageUrl?: string;
  period: string;
  insightType: SeoInsightType;
  severity: 'low' | 'medium' | 'high';
  title: string;
  summary: string;
  evidenceJson: string;
  recommendation: string;
  status: SeoInsightStatus;
  createdAt?: string;
}

export type SeoChangeImpactStatus = 'waiting_for_result' | 'improved' | 'unchanged' | 'declined' | 'not_enough_data' | 'too_early' | 'positive' | 'neutral' | 'negative';

export type RecommendationStatus =
  | 'do_not_touch'
  | 'wait'
  | 'analyze'
  | 'improve_ctr'
  | 'improve_content'
  | 'improve_internal_links'
  | 'create_supporting_article';

export interface PageSeoHealth {
  pageUrl: string;
  clicksTrend: number;
  impressionsTrend: number;
  ctrTrend: number;
  positionTrend: number;
  lastSeoChange?: SeoChangeLogEntry;
  lastSeoChangeStatus: SeoChangeImpactStatus;
  recommendationStatus: RecommendationStatus;
}
