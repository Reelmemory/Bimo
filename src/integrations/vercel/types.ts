import type { JsonValue } from '../../types/investigation.js';

export interface VercelScopeInput {
  teamId?: string;
  teamSlug?: string;
}

export interface VercelDeploymentLookupInput extends VercelScopeInput {
  deploymentIdOrUrl: string;
}

export interface VercelProjectInfo {
  [key: string]: JsonValue;
  id?: string;
  name?: string;
  framework?: string;
}

export interface VercelGitInfo {
  [key: string]: JsonValue;
  branch?: string;
  commitSha?: string;
  commitMessage?: string;
  repository?: string;
}

export interface VercelDeployment {
  [key: string]: JsonValue;
  id: string;
  url: string | null;
  status: string;
  name: string | null;
  projectId: string | null;
  project: VercelProjectInfo | null;
  git: VercelGitInfo | null;
  target: string | null;
  createdAt: string | null;
  buildingAt: string | null;
  readyAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorStep: string | null;
  regions: string[];
  metadata: { [key: string]: JsonValue };
}

export interface VercelLogEntry {
  [key: string]: JsonValue;
  id: string;
  timestamp: string;
  type: string;
  level: string | null;
  text: string;
  step: string | null;
}

export interface VercelRedeployInput extends VercelDeploymentLookupInput {
  target?: string;
  withLatestCommit?: boolean;
}

export interface VercelRollbackInput extends VercelScopeInput {
  projectId: string;
  deploymentId: string;
  description?: string;
}

export interface VercelRollbackResult {
  [key: string]: JsonValue;
  accepted: true;
  projectId: string;
  deploymentId: string;
}

export interface VercelDeploymentAlias {
  [key: string]: JsonValue;
  uid: string;
  alias: string;
  redirect: string | null;
  createdAt: string | null;
}

export interface VercelProvider {
  getDeployment(input: VercelDeploymentLookupInput): Promise<VercelDeployment>;
  getDeploymentLogs(input: VercelDeploymentLookupInput & { limit?: number }): Promise<VercelLogEntry[]>;
  redeploy(input: VercelRedeployInput): Promise<VercelDeployment>;
  rollback(input: VercelRollbackInput): Promise<VercelRollbackResult>;
  getDeploymentAliases?(input: VercelDeploymentLookupInput): Promise<VercelDeploymentAlias[]>;
}
