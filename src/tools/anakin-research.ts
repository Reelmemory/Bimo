import type { JsonValue, Evidence, EvidenceSource, EvidenceType, SourceReference } from '../types/investigation.js';
import { EvidenceSource as Source, EvidenceType as Type } from '../types/investigation.js';
import type { ResearchCapabilities } from '../integrations/research.js';
import { RiskLevel, type Tool, type ToolExecutionContext } from './types.js';

export type ResearchMode = 'search' | 'deep';

export interface AnakinResearchInput {
  query: string;
  mode?: ResearchMode;
  context?: string;
  maxResults?: number;
}

export interface AnakinResearchData {
  [key: string]: JsonValue;
  query: string;
  mode: ResearchMode;
  resultCount: number;
  summary: string;
  structuredData: JsonValue;
}

const makeEvidence = (
  context: ToolExecutionContext,
  summary: string,
  content: string | undefined,
  references: SourceReference[],
  details: JsonValue,
): Evidence => ({
  id: `${context.investigationId}-anakin-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  source: Source.ANAKIN,
  type: Type.RESEARCH,
  summary,
  ...(content ? { content } : {}),
  details,
  confidence: 0.8,
  ...(references[0]?.url ? { url: references[0].url } : {}),
  ...(references.length ? { references } : {}),
  timestamp: new Date().toISOString(),
});

export class AnakinResearchTool implements Tool<AnakinResearchInput | null, AnakinResearchData> {
  readonly name = 'anakin_research';
  readonly description = 'Researches current technical information through Anakin search or agentic research.';
  readonly riskLevel = RiskLevel.READ_ONLY;
  readonly inputDefinition = {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'Technical question or error to research.' },
      mode: { type: 'string', description: 'search for a focused lookup or deep for multi-source research.', enum: ['search', 'deep'] },
      context: { type: 'string', description: 'Optional investigation context.' },
      maxResults: { type: 'number', description: 'Maximum search results for search mode.' },
    },
    required: ['query'],
  };

  constructor(private readonly provider: ResearchCapabilities) {}

  async execute(input: AnakinResearchInput | null, context: ToolExecutionContext) {
    const researchInput: Partial<AnakinResearchInput> = input ?? {};
    const query = researchInput.query?.trim();
    if (!query) {
      return { success: false, summary: 'Anakin research requires a non-empty query.', error: 'Missing research query.' };
    }

    const mode = researchInput.mode ?? 'search';
    try {
      if (mode === 'deep') {
        if (!this.provider.research) {
          return { success: false, summary: 'Deep Anakin research is not available from the configured provider.', error: 'Research provider does not implement deep research.' };
        }
        const result = await this.provider.research(query);
        const references = result.sources;
        const evidence = makeEvidence(
          context,
          result.summary,
          result.summary,
          references,
          result.structuredData ?? { summary: result.summary },
        );
        return {
          success: true,
          summary: result.summary,
          data: {
            query,
            mode,
            resultCount: references.length,
            summary: result.summary,
            structuredData: result.structuredData ?? null,
          },
          evidence: [evidence],
          sources: references,
        };
      }

      const result = researchInput.maxResults === undefined
        ? await this.provider.search(query)
        : await this.provider.search(query, { limit: researchInput.maxResults });
      const references = result.results;
      const evidence = references.map((reference) => makeEvidence(
        context,
        reference.title ?? 'Anakin search result',
        reference.snippet,
        [reference],
        {
          title: reference.title ?? null,
          snippet: reference.snippet ?? null,
          url: reference.url,
        },
      ));
      return {
        success: true,
        summary: `Anakin found ${references.length} result(s) for the technical query.`,
        data: { query, mode, resultCount: references.length, summary: `Anakin found ${references.length} result(s) for the technical query.`, structuredData: null },
        evidence,
        sources: references,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        summary: 'Anakin research failed; no external evidence was added.',
        error: message,
        data: { query, mode, resultCount: 0 },
      };
    }
  }
}
