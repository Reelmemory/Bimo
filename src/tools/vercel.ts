import {
  EvidenceSource,
  EvidenceType,
  type Evidence,
  type JsonValue,
  type SourceReference,
} from '../types/investigation.js';
import type { NetworkDiagnosticsProvider } from '../integrations/network/types.js';
import type {
  VercelDeployment,
  VercelDeploymentLookupInput,
  VercelLogEntry,
  VercelProvider,
  VercelRedeployInput,
  VercelRollbackInput,
} from '../integrations/vercel/types.js';
import { VercelProviderError } from '../integrations/vercel/client.js';
import { redactSensitiveJson } from '../safety/redaction.js';
import { RiskLevel, type Tool, type ToolExecutionContext } from './types.js';

interface VercelLogsInput extends VercelDeploymentLookupInput {
  maxEntries?: number;
}

interface VercelCheckInput extends VercelDeploymentLookupInput {
  performHttpCheck?: boolean;
  timeoutMs?: number;
  expectedDeploymentId?: string;
  verifyProductionRouting?: boolean;
}

interface VercelLogsOutput {
  [key: string]: JsonValue;
  deploymentIdOrUrl: string;
  totalEntries: number;
  returnedEntries: number;
  errorCount: number;
  warningCount: number;
  truncated: boolean;
  logs: VercelLogEntry[];
}

interface VercelCheckOutput {
  [key: string]: JsonValue;
  healthy: boolean;
  deployment: VercelDeployment;
  httpCheck: JsonValue;
  productionRouting: JsonValue;
}

interface ProductionRoutingCheck {
  [key: string]: JsonValue;
  checked: boolean;
  confirmed: boolean | null;
  expectedDeploymentId: string | null;
  aliases: string[];
  error?: string;
}

const scopeProperties = {
  teamId: { type: 'string', description: 'Optional Vercel team ID.' },
  teamSlug: { type: 'string', description: 'Optional Vercel team slug.' },
};

const deploymentProperties = {
  deploymentIdOrUrl: { type: 'string', description: 'Vercel deployment ID or hostname.' },
  ...scopeProperties,
};

const providerFailure = (error: unknown): { code: string; message: string } => ({
  code: error instanceof VercelProviderError ? error.code : 'VERCEL_ERROR',
  message: (error instanceof Error ? error.message : String(error)).slice(0, 800),
});

const deploymentUrl = (deployment: VercelDeployment): string | undefined =>
  deployment.url ? `https://${deployment.url.replace(/^https?:\/\//, '')}` : undefined;

const deploymentSources = (deployment: VercelDeployment): SourceReference[] => {
  const url = deploymentUrl(deployment);
  return url ? [{ url, title: `Vercel deployment ${deployment.id}`, retrievedAt: new Date().toISOString() }] : [];
};

const evidence = (
  context: ToolExecutionContext,
  type: EvidenceType,
  summary: string,
  details: JsonValue,
  confidence: number,
  references: SourceReference[] = [],
  content?: string,
): Evidence => ({
  id: `${context.investigationId}-vercel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  source: EvidenceSource.VERCEL,
  type,
  summary,
  ...(content ? { content } : {}),
  details,
  confidence,
  ...(references[0]?.url ? { url: references[0].url } : {}),
  ...(references.length ? { references } : {}),
  timestamp: new Date().toISOString(),
});

const failureEvidence = (
  context: ToolExecutionContext,
  type: EvidenceType,
  failure: { code: string; message: string },
): Evidence => evidence(context, type, failure.message, failure, 0.98);

const logPriority = (entry: VercelLogEntry): number => {
  const text = `${entry.level ?? ''} ${entry.type} ${entry.step ?? ''} ${entry.text}`;
  if (entry.level === 'error' || /\b(fatal|error|failed|failure|exception|cannot|unable)\b/i.test(text)) return 0;
  if (entry.level === 'warning' || /\bwarn(?:ing)?\b/i.test(text)) return 1;
  if (/dependency|lockfile|npm|pnpm|yarn|module not found|compile|build step|typescript|webpack|next\.js/i.test(text)) return 2;
  return 3;
};

const selectLogs = (logs: VercelLogEntry[], requestedMax: number | undefined): VercelLogsOutput => {
  const maxEntries = Math.min(200, Math.max(1, Math.trunc(requestedMax ?? 80)));
  const bounded = logs.map((entry) => ({
    ...entry,
    text: String(redactSensitiveJson(entry.text.slice(0, 2000))),
  }));
  const ranked = bounded
    .map((entry, index) => ({ entry, index, priority: logPriority(entry) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index);
  const selected: VercelLogEntry[] = [];
  let characters = 0;
  for (const item of ranked) {
    if (selected.length >= maxEntries) break;
    const remaining = 12_000 - characters;
    if (remaining <= 0) break;
    const entry = item.entry.text.length > remaining
      ? { ...item.entry, text: item.entry.text.slice(0, remaining) }
      : item.entry;
    selected.push(entry);
    characters += entry.text.length;
  }
  const errors = bounded.filter((entry) => logPriority(entry) === 0).length;
  const warnings = bounded.filter((entry) => logPriority(entry) === 1).length;
  return {
    deploymentIdOrUrl: '',
    totalEntries: logs.length,
    returnedEntries: selected.length,
    errorCount: errors,
    warningCount: warnings,
    truncated: selected.length < logs.length || bounded.some((entry, index) => entry.text.length < logs[index]!.text.length),
    logs: selected,
  };
};

export class VercelGetDeploymentTool implements Tool<VercelDeploymentLookupInput, JsonValue> {
  readonly name = 'vercel_get_deployment';
  readonly description = 'Retrieves current Vercel deployment status, project, Git branch/commit, timestamps, and bounded diagnostic metadata.';
  readonly riskLevel = RiskLevel.READ_ONLY;
  readonly inputDefinition = {
    type: 'object' as const,
    properties: deploymentProperties,
    required: ['deploymentIdOrUrl'],
  };

  constructor(private readonly provider: VercelProvider) {}

  async execute(input: VercelDeploymentLookupInput, context: ToolExecutionContext) {
    try {
      const deployment = await this.provider.getDeployment(input);
      const summary = `Vercel deployment ${deployment.id} is ${deployment.status}.`;
      const sources = deploymentSources(deployment);
      return {
        success: true,
        summary,
        output: deployment,
        data: deployment,
        evidence: [evidence(context, EvidenceType.DEPLOYMENT, summary, deployment, 0.98, sources)],
        sources,
      };
    } catch (error) {
      const failure = providerFailure(error);
      return { success: false, summary: 'Vercel deployment lookup failed.', error: failure.message, data: failure, evidence: [failureEvidence(context, EvidenceType.DEPLOYMENT, failure)] };
    }
  }
}

export class VercelGetDeploymentLogsTool implements Tool<VercelLogsInput, JsonValue> {
  readonly name = 'vercel_get_deployment_logs';
  readonly description = 'Retrieves bounded Vercel build logs, prioritizing errors, warnings, dependency failures, and framework/compiler failures.';
  readonly riskLevel = RiskLevel.READ_ONLY;
  readonly inputDefinition = {
    type: 'object' as const,
    properties: {
      ...deploymentProperties,
      maxEntries: { type: 'integer', description: 'Maximum normalized log entries to return, capped at 200.' },
    },
    required: ['deploymentIdOrUrl'],
  };

  constructor(private readonly provider: VercelProvider) {}

  async execute(input: VercelLogsInput, context: ToolExecutionContext) {
    try {
      const logs = await this.provider.getDeploymentLogs({
        deploymentIdOrUrl: input.deploymentIdOrUrl,
        ...(input.teamId ? { teamId: input.teamId } : {}),
        ...(input.teamSlug ? { teamSlug: input.teamSlug } : {}),
        limit: Math.min(1000, Math.max(200, (input.maxEntries ?? 80) * 5)),
      });
      const output = selectLogs(logs, input.maxEntries);
      output.deploymentIdOrUrl = input.deploymentIdOrUrl;
      const summary = `Selected ${output.returnedEntries} of ${output.totalEntries} Vercel log entries, including ${output.errorCount} error(s) and ${output.warningCount} warning(s).`;
      const content = output.logs.map((entry) => `[${entry.level ?? entry.type}] ${entry.step ? `${entry.step}: ` : ''}${entry.text}`).join('\n');
      const sources = [{
        url: 'https://vercel.com/docs/rest-api/reference/endpoints/deployments/get-deployment-events',
        title: 'Vercel deployment events API',
        retrievedAt: new Date().toISOString(),
      }];
      return {
        success: true,
        summary,
        output,
        data: output,
        evidence: [evidence(context, EvidenceType.LOG, summary, output, 0.95, sources, content)],
        sources,
      };
    } catch (error) {
      const failure = providerFailure(error);
      return { success: false, summary: 'Vercel deployment logs could not be retrieved.', error: failure.message, data: failure, evidence: [failureEvidence(context, EvidenceType.LOG, failure)] };
    }
  }
}

export class VercelCheckDeploymentTool implements Tool<VercelCheckInput, JsonValue> {
  readonly name = 'vercel_check_deployment';
  readonly description = 'Verifies Vercel deployment state and, when available, checks the deployment URL over HTTP.';
  readonly riskLevel = RiskLevel.READ_ONLY;
  readonly inputDefinition = {
    type: 'object' as const,
    properties: {
      ...deploymentProperties,
      performHttpCheck: { type: 'boolean', description: 'Whether to check the deployment URL over HTTP; defaults to true.' },
      timeoutMs: { type: 'integer', description: 'Optional HTTP timeout in milliseconds.' },
      expectedDeploymentId: { type: 'string', description: 'Deployment ID expected to receive production traffic after a rollback.' },
      verifyProductionRouting: { type: 'boolean', description: 'When true, independently confirms that aliases are assigned to the expected deployment.' },
    },
    required: ['deploymentIdOrUrl'],
  };

  constructor(
    private readonly provider: VercelProvider,
    private readonly networkProvider?: NetworkDiagnosticsProvider,
  ) {}

  async execute(input: VercelCheckInput, context: ToolExecutionContext) {
    try {
      const deployment = await this.provider.getDeployment({
        deploymentIdOrUrl: input.deploymentIdOrUrl,
        ...(input.teamId ? { teamId: input.teamId } : {}),
        ...(input.teamSlug ? { teamSlug: input.teamSlug } : {}),
      });
      let httpCheck: JsonValue = null;
      const url = deploymentUrl(deployment);
      if ((input.performHttpCheck ?? true) && this.networkProvider && url) {
        try {
          httpCheck = await this.networkProvider.httpHealthCheck({
            url,
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          });
        } catch (error) {
          httpCheck = { error: (error instanceof Error ? error.message : String(error)).slice(0, 800) };
        }
      }
      const httpHealthy = !httpCheck || (typeof httpCheck === 'object' && !Array.isArray(httpCheck) && httpCheck !== null
        && !('ok' in httpCheck) ? false : Boolean((httpCheck as { ok?: JsonValue } | null)?.ok));
      const httpRequired = Boolean((input.performHttpCheck ?? true) && this.networkProvider && url);
      let productionRouting: ProductionRoutingCheck = { checked: false, confirmed: null, expectedDeploymentId: input.expectedDeploymentId ?? null, aliases: [] };
      if (input.verifyProductionRouting) {
        const expectedDeploymentId = input.expectedDeploymentId ?? deployment.id;
        if (!this.provider.getDeploymentAliases) {
          productionRouting = {
            checked: true,
            confirmed: false,
            expectedDeploymentId,
            aliases: [],
            error: 'The Vercel provider cannot independently confirm production routing.',
          };
        } else {
          try {
            const aliases = await this.provider.getDeploymentAliases({
              deploymentIdOrUrl: expectedDeploymentId,
              ...(input.teamId ? { teamId: input.teamId } : {}),
              ...(input.teamSlug ? { teamSlug: input.teamSlug } : {}),
            });
            productionRouting = {
              checked: true,
              confirmed: aliases.length > 0,
              expectedDeploymentId,
              aliases: aliases.map((alias) => alias.alias),
            };
          } catch (error) {
            productionRouting = {
              checked: true,
              confirmed: false,
              expectedDeploymentId,
              aliases: [],
              error: providerFailure(error).message,
            };
          }
        }
      }
      const routingRequired = input.verifyProductionRouting === true;
      const routingHealthy = !routingRequired || productionRouting.confirmed === true;
      const healthy = deployment.status === 'READY' && (!httpRequired || httpHealthy) && routingHealthy;
      const output: VercelCheckOutput = { healthy, deployment, httpCheck, productionRouting };
      const summary = healthy
        ? `Vercel deployment ${deployment.id} is READY and its health checks passed${routingRequired ? ' with production routing confirmed' : ''}.`
        : `Vercel deployment ${deployment.id} is not healthy; deployment state is ${deployment.status}${httpRequired && !httpHealthy ? ' and the HTTP check did not pass' : ''}${routingRequired && !routingHealthy ? ' and production routing was not confirmed' : ''}.`;
      const sources = deploymentSources(deployment);
      return {
        success: true,
        summary,
        output,
        data: output,
        evidence: [evidence(context, EvidenceType.VERIFICATION, summary, output, 0.98, sources)],
        sources,
      };
    } catch (error) {
      const failure = providerFailure(error);
      return { success: false, summary: 'Vercel deployment verification failed to run.', error: failure.message, data: failure, evidence: [failureEvidence(context, EvidenceType.VERIFICATION, failure)] };
    }
  }
}

export class VercelRedeployTool implements Tool<VercelRedeployInput, JsonValue> {
  readonly name = 'vercel_redeploy';
  readonly description = 'Creates a new Vercel deployment from an existing deployment. This changes external deployment state.';
  readonly riskLevel = RiskLevel.CONSEQUENTIAL;
  readonly inputDefinition = {
    type: 'object' as const,
    properties: {
      ...deploymentProperties,
      target: { type: 'string', description: 'Optional Vercel deployment target such as production or preview.' },
      withLatestCommit: { type: 'boolean', description: 'Use the latest commit rather than the original deployment SHA.' },
    },
    required: ['deploymentIdOrUrl'],
  };

  constructor(private readonly provider: VercelProvider) {}

  async execute(input: VercelRedeployInput, context: ToolExecutionContext) {
    try {
      const deployment = await this.provider.redeploy(input);
      const summary = `Vercel accepted the redeployment and created ${deployment.id} in state ${deployment.status}.`;
      const sources = deploymentSources(deployment);
      return {
        success: true,
        summary,
        output: deployment,
        data: deployment,
        evidence: [evidence(context, EvidenceType.DEPLOYMENT, summary, deployment, 0.99, sources)],
        sources,
      };
    } catch (error) {
      const failure = providerFailure(error);
      return { success: false, summary: 'Vercel redeployment was not created.', error: failure.message, data: failure, evidence: [failureEvidence(context, EvidenceType.DEPLOYMENT, failure)] };
    }
  }
}

export class VercelRollbackTool implements Tool<VercelRollbackInput, JsonValue> {
  readonly name = 'vercel_rollback';
  readonly description = 'Requests that Vercel point production traffic to a specified previous deployment. This changes production routing.';
  readonly riskLevel = RiskLevel.CONSEQUENTIAL;
  readonly inputDefinition = {
    type: 'object' as const,
    properties: {
      projectId: { type: 'string', description: 'Vercel project ID.' },
      deploymentId: { type: 'string', description: 'Previous production deployment ID to roll back to.' },
      description: { type: 'string', description: 'Optional rollback reason.' },
      ...scopeProperties,
    },
    required: ['projectId', 'deploymentId'],
  };

  constructor(private readonly provider: VercelProvider) {}

  async execute(input: VercelRollbackInput, context: ToolExecutionContext) {
    try {
      const result = await this.provider.rollback(input);
      const summary = `Vercel accepted the rollback request for project ${result.projectId} to deployment ${result.deploymentId}; completion must be verified separately.`;
      return {
        success: true,
        summary,
        output: result,
        data: result,
        evidence: [evidence(context, EvidenceType.DEPLOYMENT, summary, result, 0.99)],
      };
    } catch (error) {
      const failure = providerFailure(error);
      return { success: false, summary: 'Vercel rollback request was not accepted.', error: failure.message, data: failure, evidence: [failureEvidence(context, EvidenceType.DEPLOYMENT, failure)] };
    }
  }
}

export const createVercelTools = (
  provider: VercelProvider,
  networkProvider?: NetworkDiagnosticsProvider,
) => [
  new VercelGetDeploymentTool(provider),
  new VercelGetDeploymentLogsTool(provider),
  new VercelCheckDeploymentTool(provider, networkProvider),
  new VercelRedeployTool(provider),
  new VercelRollbackTool(provider),
];
