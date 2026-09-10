import type { JsonValue, SourceReference } from '../types/investigation.js';

export interface WebSearchResult {
  query: string;
  results: SourceReference[];
}

export interface DeepResearchResult {
  query: string;
  summary: string;
  structuredData?: JsonValue;
  sources: SourceReference[];
}

export interface WebSearchProvider {
  search(query: string, options?: { limit?: number }): Promise<WebSearchResult>;
}

export interface DeepResearchProvider {
  research(query: string): Promise<DeepResearchResult>;
}

export interface ResearchProvider extends WebSearchProvider, DeepResearchProvider {}

export type ResearchCapabilities = WebSearchProvider & Partial<DeepResearchProvider>;
