import { Vercel } from '@vercel/sdk';
import type {
  VercelDeployment,
  VercelDeploymentLookupInput,
  VercelDeploymentAlias,
  VercelGitInfo,
  VercelLogEntry,
  VercelProjectInfo,
  VercelProvider,
  VercelRedeployInput,
  VercelRollbackInput,
  VercelRollbackResult,
} from './types.js';

export type VercelErrorCode = 'AUTHENTICATION' | 'RATE_LIMIT' | 'NOT_FOUND' | 'TIMEOUT' | 'INVALID_INPUT' | 'INVALID_RESPONSE' | 'PROVIDER_ERROR';

export class VercelConfigurationError extends Error {
  constructor(message = 'VERCEL_TOKEN is required to use the Vercel provider.') {
    super(message);
    this.name = 'VercelConfigurationError';
  }
}

export class VercelProviderError extends Error {
  constructor(
    readonly code: VercelErrorCode,
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'VercelProviderError';
  }
}

export interface VercelSdkLike {
  deployments: {
    getDeployment(request: Record<string, unknown>): Promise<unknown>;
    getDeploymentEvents(request: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
    createDeployment(request: Record<string, unknown>): Promise<unknown>;
  };
  projects: {
    requestRollback(request: Record<string, unknown>): Promise<void>;
  };
  aliases?: {
    listDeploymentAliases(request: Record<string, unknown>): Promise<unknown>;
  };
}

export interface CreateVercelClientOptions {
  token?: string;
  timeoutMs?: number;
  sdkClient?: VercelSdkLike;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const toIsoTimestamp = (value: unknown): string | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const safeMessage = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:token|key|api_key|apikey)=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, 800);
};

const statusFromError = (error: unknown): number | undefined => {
  const record = asRecord(error);
  for (const value of [record?.statusCode, record?.status, asRecord(record?.response)?.status]) {
    if (typeof value === 'number') return value;
  }
  return undefined;
};

export const normalizeVercelError = (error: unknown): VercelProviderError => {
  if (error instanceof VercelProviderError) return error;
  const status = statusFromError(error);
  const message = safeMessage(error);
  if (status === 401 || status === 403 || /unauthori[sz]ed|authentication|invalid token/i.test(message)) {
    return new VercelProviderError('AUTHENTICATION', `Vercel authentication failed: ${message}`, status);
  }
  if (status === 404 || /not found/i.test(message)) return new VercelProviderError('NOT_FOUND', `Vercel deployment was not found: ${message}`, status);
  if (status === 429 || /rate limit/i.test(message)) return new VercelProviderError('RATE_LIMIT', `Vercel rate limit reached: ${message}`, status);
  if (/timed? out|timeout|aborted/i.test(message)) return new VercelProviderError('TIMEOUT', `Vercel request timed out: ${message}`, status);
  return new VercelProviderError('PROVIDER_ERROR', `Vercel request failed: ${message}`, status);
};

const scopeRequest = (input: { teamId?: string; teamSlug?: string }): Record<string, unknown> => ({
  ...(input.teamId ? { teamId: input.teamId } : {}),
  ...(input.teamSlug ? { slug: input.teamSlug } : {}),
});

const deploymentIdentifier = (value: string): string => {
  const identifier = value.trim();
  if (!identifier) throw new VercelProviderError('INVALID_INPUT', 'A Vercel deployment ID or URL is required.');
  if (/^https?:\/\//i.test(identifier)) {
    try {
      return new URL(identifier).hostname;
    } catch {
      throw new VercelProviderError('INVALID_INPUT', 'The Vercel deployment URL is malformed.');
    }
  }
  return identifier.replace(/\/$/, '');
};

const metaValue = (meta: Record<string, unknown> | null, names: string[]): string | undefined => {
  for (const name of names) {
    const value = stringValue(meta?.[name]);
    if (value) return value;
  }
  return undefined;
};

const normalizeProject = (raw: Record<string, unknown>): VercelProjectInfo | null => {
  const project = asRecord(raw.project);
  const id = stringValue(project?.id) ?? stringValue(raw.projectId);
  const name = stringValue(project?.name) ?? stringValue(raw.name);
  const framework = stringValue(project?.framework);
  if (!id && !name && !framework) return null;
  return {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(framework ? { framework } : {}),
  };
};

const normalizeGit = (raw: Record<string, unknown>): VercelGitInfo | null => {
  const git = asRecord(raw.gitSource);
  const meta = asRecord(raw.meta);
  const branch = stringValue(git?.ref) ?? metaValue(meta, ['githubCommitRef', 'gitlabCommitRef', 'bitbucketCommitRef', 'gitCommitRef']);
  const commitSha = stringValue(git?.sha) ?? metaValue(meta, ['githubCommitSha', 'gitlabCommitSha', 'bitbucketCommitSha', 'gitCommitSha']);
  const commitMessage = metaValue(meta, ['githubCommitMessage', 'gitlabCommitMessage', 'bitbucketCommitMessage', 'gitCommitMessage']);
  const repository = stringValue(git?.repo) ?? metaValue(meta, ['githubCommitRepo', 'gitlabCommitRepo', 'bitbucketCommitRepo']);
  if (!branch && !commitSha && !commitMessage && !repository) return null;
  return {
    ...(branch ? { branch } : {}),
    ...(commitSha ? { commitSha } : {}),
    ...(commitMessage ? { commitMessage } : {}),
    ...(repository ? { repository } : {}),
  };
};

export const normalizeVercelDeployment = (value: unknown): VercelDeployment => {
  const raw = asRecord(value);
  const id = stringValue(raw?.id);
  if (!raw || !id) throw new VercelProviderError('INVALID_RESPONSE', 'Vercel returned a deployment without an ID.');
  const readyState = stringValue(raw.readyState);
  const status = readyState ?? stringValue(raw.status) ?? 'UNKNOWN';
  const projectId = stringValue(raw.projectId) ?? stringValue(asRecord(raw.project)?.id) ?? null;
  return {
    id,
    url: stringValue(raw.url) ?? null,
    status,
    name: stringValue(raw.name) ?? null,
    projectId,
    project: normalizeProject(raw),
    git: normalizeGit(raw),
    target: stringValue(raw.target) ?? null,
    createdAt: toIsoTimestamp(raw.createdAt),
    buildingAt: toIsoTimestamp(raw.buildingAt),
    readyAt: toIsoTimestamp(raw.ready ?? raw.readyStateAt),
    errorCode: stringValue(raw.errorCode) ?? null,
    errorMessage: stringValue(raw.errorMessage) ?? null,
    errorStep: stringValue(raw.errorStep) ?? null,
    regions: stringArray(raw.regions),
    metadata: {
      buildSkipped: raw.buildSkipped === true,
      ...(typeof raw.checksState === 'string' ? { checksState: raw.checksState } : {}),
      ...(typeof raw.checksConclusion === 'string' ? { checksConclusion: raw.checksConclusion } : {}),
      ...(typeof raw.readyStateReason === 'string' ? { readyStateReason: raw.readyStateReason } : {}),
    },
  };
};

const normalizeLogEntry = (value: unknown, index: number): VercelLogEntry | null => {
  const event = asRecord(value);
  if (!event) return null;
  const payload = asRecord(event.payload);
  const info = asRecord(event.info) ?? asRecord(payload?.info);
  const text = stringValue(event.text) ?? stringValue(payload?.text) ?? '';
  const date = event.date ?? payload?.date ?? event.created ?? payload?.created;
  return {
    id: stringValue(event.id) ?? stringValue(payload?.id) ?? `vercel-log-${index + 1}`,
    timestamp: toIsoTimestamp(date) ?? new Date(0).toISOString(),
    type: stringValue(event.type) ?? stringValue(info?.type) ?? 'unknown',
    level: stringValue(event.level) ?? null,
    text,
    step: stringValue(info?.step) ?? stringValue(info?.name) ?? null,
  };
};

const normalizeDeploymentAlias = (value: unknown, index: number): VercelDeploymentAlias | null => {
  const raw = asRecord(value);
  const alias = stringValue(raw?.alias);
  if (!raw || !alias) return null;
  return {
    uid: stringValue(raw.uid) ?? `vercel-alias-${index + 1}`,
    alias,
    redirect: stringValue(raw.redirect) ?? null,
    createdAt: toIsoTimestamp(raw.created),
  };
};

export class VercelClient implements VercelProvider {
  constructor(private readonly sdk: VercelSdkLike) {}

  async getDeployment(input: VercelDeploymentLookupInput): Promise<VercelDeployment> {
    try {
      const result = await this.sdk.deployments.getDeployment({
        idOrUrl: deploymentIdentifier(input.deploymentIdOrUrl),
        withGitRepoInfo: 'true',
        ...scopeRequest(input),
      });
      return normalizeVercelDeployment(result);
    } catch (error) {
      throw normalizeVercelError(error);
    }
  }

  async getDeploymentLogs(input: VercelDeploymentLookupInput & { limit?: number }): Promise<VercelLogEntry[]> {
    try {
      const result = await this.sdk.deployments.getDeploymentEvents({
        idOrUrl: deploymentIdentifier(input.deploymentIdOrUrl),
        direction: 'backward',
        limit: input.limit ?? 500,
        ...scopeRequest(input),
      }, { acceptHeaderOverride: 'application/json' });
      const events = Array.isArray(result) ? result : [result];
      return events.map(normalizeLogEntry).filter((entry): entry is VercelLogEntry => entry !== null);
    } catch (error) {
      throw normalizeVercelError(error);
    }
  }

  async getDeploymentAliases(input: VercelDeploymentLookupInput): Promise<VercelDeploymentAlias[]> {
    if (!this.sdk.aliases?.listDeploymentAliases) {
      throw new VercelProviderError('PROVIDER_ERROR', 'The configured Vercel SDK does not support deployment alias lookup.');
    }
    try {
      const result = await this.sdk.aliases.listDeploymentAliases({
        id: deploymentIdentifier(input.deploymentIdOrUrl),
        ...scopeRequest(input),
      });
      const record = asRecord(result);
      const values = Array.isArray(result) ? result : record && Array.isArray(record.aliases) ? record.aliases : null;
      if (!values) throw new VercelProviderError('INVALID_RESPONSE', 'Vercel returned an invalid deployment alias response.');
      return values.map(normalizeDeploymentAlias).filter((alias): alias is VercelDeploymentAlias => alias !== null);
    } catch (error) {
      throw normalizeVercelError(error);
    }
  }

  async redeploy(input: VercelRedeployInput): Promise<VercelDeployment> {
    try {
      const source = await this.getDeployment(input);
      const result = await this.sdk.deployments.createDeployment({
        ...scopeRequest(input),
        requestBody: {
          name: source.name ?? source.project?.name ?? 'bimo-redeployment',
          ...(source.projectId ? { project: source.projectId } : {}),
          deploymentId: source.id,
          ...(input.target ? { target: input.target } : source.target ? { target: source.target } : {}),
          ...(input.withLatestCommit !== undefined ? { withLatestCommit: input.withLatestCommit } : {}),
        },
      });
      return normalizeVercelDeployment(result);
    } catch (error) {
      throw normalizeVercelError(error);
    }
  }

  async rollback(input: VercelRollbackInput): Promise<VercelRollbackResult> {
    try {
      await this.sdk.projects.requestRollback({
        projectId: input.projectId,
        deploymentId: input.deploymentId,
        ...(input.description ? { description: input.description } : {}),
        ...scopeRequest(input),
      });
      return { accepted: true, projectId: input.projectId, deploymentId: input.deploymentId };
    } catch (error) {
      throw normalizeVercelError(error);
    }
  }
}

export const createVercelClient = (options: CreateVercelClientOptions = {}): VercelClient => {
  if (options.sdkClient) return new VercelClient(options.sdkClient);
  const token = (options.token ?? process.env.VERCEL_TOKEN)?.trim();
  if (!token) throw new VercelConfigurationError();
  const sdk = new Vercel({ bearerToken: token, timeoutMs: options.timeoutMs ?? 15_000 });
  return new VercelClient(sdk as unknown as VercelSdkLike);
};
