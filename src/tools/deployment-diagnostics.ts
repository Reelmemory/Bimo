import type { Evidence, JsonValue } from '../types/investigation.js';
import { EvidenceSource, EvidenceType } from '../types/investigation.js';
import type { ResearchMode } from './anakin-research.js';
import type { ResearchCapabilities } from '../integrations/research.js';
import { RiskLevel, type Tool, type ToolExecutionContext } from './types.js';

export interface DeploymentDiagnosticsInput {
  deploymentUrl?: string;
  errorMessage?: string;
  buildOutput?: string;
  framework?: string;
  packageManager?: string;
  environment?: Record<string, string>;
  researchMode?: ResearchMode;
}

export interface DeploymentDiagnosticsData {
  [key: string]: JsonValue;
  query: string;
  researchMode: ResearchMode;
  researched: boolean;
  normalizedContext: JsonValue;
}

const toContextEvidence = (input: DeploymentDiagnosticsInput, context: ToolExecutionContext): Evidence => {
  const parts = [
    input.deploymentUrl && `Deployment URL: ${input.deploymentUrl}`,
    input.framework && `Framework: ${input.framework}`,
    input.packageManager && `Package manager: ${input.packageManager}`,
    input.errorMessage && `Error: ${input.errorMessage}`,
    input.buildOutput && `Build output: ${input.buildOutput}`,
  ].filter((part): part is string => Boolean(part));
  const normalizedContext = {
    ...(input.deploymentUrl ? { deploymentUrl: input.deploymentUrl } : {}),
    ...(input.framework ? { framework: input.framework } : {}),
    ...(input.packageManager ? { packageManager: input.packageManager } : {}),
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    ...(input.buildOutput ? { buildOutput: input.buildOutput } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
  };
  return {
    id: `${context.investigationId}-deployment-context-${Date.now()}`,
    source: EvidenceSource.USER,
    type: EvidenceType.DEPLOYMENT_CONTEXT,
    summary: 'Normalized deployment context supplied for diagnosis.',
    content: parts.join('\n'),
    details: normalizedContext,
    confidence: 1,
    timestamp: new Date().toISOString(),
  };
};

const buildQuery = (input: DeploymentDiagnosticsInput): string => {
  const subject = input.errorMessage || input.buildOutput || 'deployment build failure';
  const qualifiers = [input.framework, input.packageManager].filter(Boolean).join(' ');
  return `${qualifiers ? `${qualifiers} ` : ''}${subject} deployment troubleshooting official documentation`.trim();
};

const selectMode = (input: DeploymentDiagnosticsInput): ResearchMode => {
  if (input.researchMode) return input.researchMode;
  const text = `${input.errorMessage ?? ''} ${input.buildOutput ?? ''}`;
  return text.length > 700 || /\b(and|also|multiple|several)\b/i.test(text) ? 'deep' : 'search';
};

export class DeploymentDiagnosticsTool implements Tool<DeploymentDiagnosticsInput | null, DeploymentDiagnosticsData> {
  readonly name = 'deployment_diagnostics';
  readonly description = 'Normalizes deployment context and researches the relevant technical failure through a provider.';
  readonly riskLevel = RiskLevel.READ_ONLY;
  readonly inputDefinition = {
    type: 'object' as const,
    properties: {
      deploymentUrl: { type: 'string' },
      errorMessage: { type: 'string' },
      buildOutput: { type: 'string' },
      framework: { type: 'string' },
      packageManager: { type: 'string' },
      environment: { type: 'object' },
      researchMode: { type: 'string' },
    },
  };

  constructor(private readonly provider: ResearchCapabilities) {}

  async execute(input: DeploymentDiagnosticsInput | null, context: ToolExecutionContext) {
    const diagnosticsInput = input ?? {};
    const normalizedEvidence = toContextEvidence(diagnosticsInput, context);
    const query = buildQuery(diagnosticsInput);
    const researchMode = selectMode(diagnosticsInput);
    try {
      if (researchMode === 'deep') {
        if (!this.provider.research) {
          return {
            success: false,
            summary: 'Deployment context was normalized, but deep research is unavailable.',
            error: 'Research provider does not implement deep research.',
            data: { query, researchMode, researched: false, normalizedContext: normalizedEvidence.details ?? {} },
            evidence: [normalizedEvidence],
          };
        }
        const result = await this.provider.research(query);
        const researchEvidence = [{
          id: `${context.investigationId}-deployment-research-${Date.now()}`,
          source: EvidenceSource.ANAKIN,
          type: EvidenceType.RESEARCH,
          summary: result.summary,
          content: result.summary,
          details: result.structuredData ?? { summary: result.summary },
          confidence: 0.8,
          ...(result.sources[0]?.url ? { url: result.sources[0].url } : {}),
          ...(result.sources.length ? { references: result.sources } : {}),
          timestamp: new Date().toISOString(),
        } satisfies Evidence];
        return {
          success: true,
          summary: result.summary,
          data: {
            query,
            researchMode,
            researched: true,
            normalizedContext: normalizedEvidence.details ?? {},
          },
          evidence: [normalizedEvidence, ...researchEvidence],
          sources: result.sources,
        };
      }

      const result = await this.provider.search(query);
      const researchEvidence = result.results.map((reference) => ({
          id: `${context.investigationId}-deployment-search-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          source: EvidenceSource.ANAKIN,
          type: EvidenceType.DOCUMENTATION,
          summary: reference.title ?? 'Anakin deployment research result',
          ...(reference.snippet ? { content: reference.snippet } : {}),
          details: { url: reference.url, snippet: reference.snippet ?? null },
          confidence: 0.75,
          url: reference.url,
          references: [reference],
          timestamp: new Date().toISOString(),
        } satisfies Evidence));
      return {
        success: true,
        summary: `Deployment context normalized and ${result.results.length} Anakin result(s) collected.`,
        data: {
          query,
          researchMode,
          researched: true,
          normalizedContext: normalizedEvidence.details ?? {},
        },
        evidence: [normalizedEvidence, ...researchEvidence],
        sources: result.results,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        summary: 'Deployment context was normalized, but external research failed.',
        error: message,
        data: { query, researchMode, researched: false, normalizedContext: normalizedEvidence.details ?? {} },
        evidence: [normalizedEvidence],
      };
    }
  }
}
