import type { RiskLevel } from '../tools/types.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export enum EvidenceSource {
  USER = 'USER',
  TOOL = 'TOOL',
  WEB = 'WEB',
  ANAKIN = 'ANAKIN',
  VERCEL = 'VERCEL',
  NETWORK = 'NETWORK',
  WEB3 = 'WEB3',
  SYSTEM = 'SYSTEM',
  VERIFIER = 'VERIFIER',
}

export enum EvidenceType {
  USER_PROBLEM = 'USER_PROBLEM',
  DEPLOYMENT_CONTEXT = 'DEPLOYMENT_CONTEXT',
  DEPLOYMENT = 'DEPLOYMENT',
  ERROR = 'ERROR',
  LOG = 'LOG',
  RESEARCH = 'RESEARCH',
  DOCUMENTATION = 'DOCUMENTATION',
  OBSERVATION = 'OBSERVATION',
  VERIFICATION = 'VERIFICATION',
  HTTP = 'HTTP',
  DNS = 'DNS',
  TLS = 'TLS',
  TRANSACTION = 'TRANSACTION',
  BLOCK = 'BLOCK',
}

export interface SourceReference {
  url: string;
  title?: string;
  snippet?: string;
  date?: string;
  lastUpdated?: string;
  retrievedAt?: string;
}

export const toJsonValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, toJsonValue(item)]));
  }
  return String(value);
};

export enum InvestigationStatus {
  INITIALIZING = 'INITIALIZING',
  READING = 'READING',
  REASONING = 'REASONING',
  PLANNING = 'PLANNING',
  AWAITING_APPROVAL = 'AWAITING_APPROVAL',
  ACTING = 'ACTING',
  VERIFYING = 'VERIFYING',
  RECOVERING = 'RECOVERING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  REJECTED = 'REJECTED',
}

export enum VerificationStatus {
  PASSED = 'PASSED',
  FAILED = 'FAILED',
}

export enum ApprovalStatus {
  NOT_REQUIRED = 'NOT_REQUIRED',
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export interface Evidence {
  id: string;
  source: EvidenceSource | string;
  type?: EvidenceType | string;
  summary: string;
  content?: string;
  details?: JsonValue;
  confidence?: number;
  url?: string;
  reference?: string;
  references?: SourceReference[];
  timestamp: string;
}

export interface Hypothesis {
  id: string;
  statement: string;
  rationale?: string;
  confidence?: number;
}

export interface PlannedAction {
  id: string;
  toolName: string;
  input?: JsonValue;
  arguments?: JsonValue;
  purpose?: string;
  expectedResult?: string;
  riskLevel?: RiskLevel;
  rationale?: string;
}

export interface ActionPlan {
  id: string;
  objective: string;
  actions: PlannedAction[];
  rationale?: string;
}

export interface ActionResult {
  actionId: string;
  toolName: string;
  success: boolean;
  summary?: string;
  output?: JsonValue;
  data?: JsonValue;
  sources?: SourceReference[];
  error?: string;
  startedAt: string;
  completedAt: string;
}

export interface VerificationResult {
  status: VerificationStatus;
  summary: string;
  evidence?: Evidence[];
  details?: JsonValue;
}

export interface ApprovalState {
  status: ApprovalStatus;
  actionId?: string;
  toolName?: string;
  riskLevel?: RiskLevel;
  reason?: string;
  decidedAt?: string;
}

export type FinalOutcome = 'SUCCESS' | 'FAILED' | 'REJECTED' | 'MAX_RECOVERY_ATTEMPTS';

export interface FinalResult {
  outcome: FinalOutcome;
  summary: string;
  hypothesis?: Hypothesis;
  actionsExecuted: number;
  recoveryAttempts: number;
}

export interface InvestigationState {
  id: string;
  userProblem: string;
  status: InvestigationStatus;
  observations: string[];
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  actionHistory?: ActionResult[];
  events?: InvestigationEvent[];
  reasoningSummary?: string | null;
  recommendedNextStep?: string | null;
  currentHypothesis: Hypothesis | null;
  plan: ActionPlan | null;
  currentAction: PlannedAction | null;
  actionResult: ActionResult | null;
  verification: VerificationResult | null;
  approval: ApprovalState;
  recoveryAttempts: number;
  finalResult: FinalResult | null;
}

export enum InvestigationEventType {
  INVESTIGATION_STARTED = 'INVESTIGATION_STARTED',
  REASONING = 'REASONING',
  TOOL_SELECTED = 'TOOL_SELECTED',
  APPROVAL_REQUESTED = 'APPROVAL_REQUESTED',
  APPROVAL_DECIDED = 'APPROVAL_DECIDED',
  TOOL_RESULT = 'TOOL_RESULT',
  VERIFICATION_RESULT = 'VERIFICATION_RESULT',
  RECOVERY = 'RECOVERY',
  INVESTIGATION_COMPLETED = 'INVESTIGATION_COMPLETED',
  INVESTIGATION_FAILED = 'INVESTIGATION_FAILED',
}

export interface InvestigationEvent {
  id: string;
  investigationId: string;
  type: InvestigationEventType;
  timestamp: string;
  data: JsonValue;
}
