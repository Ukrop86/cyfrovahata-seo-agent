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
