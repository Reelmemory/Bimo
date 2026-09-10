import { Anakin } from '@anakin-io/sdk';
import type { JsonValue, SourceReference } from '../../types/investigation.js';
import type { DeepResearchResult, ResearchProvider, WebSearchResult } from '../research.js';
import type {
  AnakinSdkAgenticSearchResult,
  AnakinSdkClientLike,
  AnakinSdkSearchResult,
} from './types.js';

export class AnakinConfigurationError extends Error {
  constructor(message = 'ANAKIN_API_KEY is required to use Anakin research.') {
    super(message);
    this.name = 'AnakinConfigurationError';
  }
}

export interface AnakinClientOptions {
  apiKey?: string;
  sdkClient?: AnakinSdkClientLike;
}

const toJsonValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, toJsonValue(item)]));
  }
  return String(value);
};

const extractReferences = (value: unknown, references: SourceReference[] = []): SourceReference[] => {
  if (Array.isArray(value)) {
    for (const item of value) extractReferences(item, references);
    return references;
  }
  if (!value || typeof value !== 'object') return references;
  const record = value as Record<string, unknown>;
  if (typeof record.url === 'string') {
    references.push({
      url: record.url,
      ...(typeof record.title === 'string' ? { title: record.title } : {}),
      ...(typeof record.snippet === 'string' ? { snippet: record.snippet } : {}),
    });
  }
  for (const item of Object.values(record)) extractReferences(item, references);
  return references;
};

export class AnakinResearchClient implements ResearchProvider {
  private readonly sdk: AnakinSdkClientLike;

  constructor(sdkOrOptions?: AnakinSdkClientLike | AnakinClientOptions) {
    if (sdkOrOptions && 'search' in sdkOrOptions && 'agenticSearch' in sdkOrOptions) {
      this.sdk = sdkOrOptions;
      return;
    }
    const options = sdkOrOptions ?? {};
    if (options.sdkClient) {
      this.sdk = options.sdkClient;
      return;
    }
    const apiKey = (options.apiKey ?? process.env.ANAKIN_API_KEY)?.trim();
    if (!apiKey) throw new AnakinConfigurationError();
    this.sdk = new Anakin({ apiKey });
  }

  async search(query: string, options?: { limit?: number }): Promise<WebSearchResult> {
    const result = await this.sdk.search(query, options);
    return this.normalizeSearch(query, result);
  }

  async research(query: string): Promise<DeepResearchResult> {
    const result = await this.sdk.agenticSearch(query);
    return this.normalizeResearch(query, result);
  }

  private normalizeSearch(query: string, result: AnakinSdkSearchResult): WebSearchResult {
    return {
      query,
      results: result.results.map((item) => ({
        url: item.url,
        ...(item.title ? { title: item.title } : {}),
        ...(item.snippet ? { snippet: item.snippet } : {}),
        ...(item.date ? { date: item.date } : {}),
        ...(item.lastUpdated ? { lastUpdated: item.lastUpdated } : {}),
        retrievedAt: new Date().toISOString(),
      })),
    };
  }

  private normalizeResearch(query: string, result: AnakinSdkAgenticSearchResult): DeepResearchResult {
    if (result.status === 'failed') throw new Error(result.error ?? 'Anakin agentic research failed.');
    const generated = result.generatedJson;
    const structuredData = generated?.structured_data === undefined ? undefined : toJsonValue(generated.structured_data);
    const sources = extractReferences(generated?.structured_data);
    return {
      query,
      summary: generated?.summary ?? 'Anakin completed research without a summary.',
      ...(structuredData !== undefined ? { structuredData } : {}),
      sources,
    };
  }
}

export const createAnakinResearchClient = (options: AnakinClientOptions = {}): AnakinResearchClient => {
  return new AnakinResearchClient(options);
};
