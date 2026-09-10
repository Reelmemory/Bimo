import type {
  ActionResult,
  Evidence,
  Hypothesis,
  InvestigationState,
  JsonValue,
} from '../types/investigation.js';
import { RiskLevel, type ToolDescriptor } from '../tools/types.js';

export enum AIReasoningDecision {
  NEED_INFORMATION = 'NEED_INFORMATION',
  TAKE_ACTION = 'TAKE_ACTION',
  VERIFY = 'VERIFY',
  COMPLETE = 'COMPLETE',
  RECOVER = 'RECOVER',
}

export interface AIReasonerInput {
  userProblem: string;
  state: InvestigationState;
  observations: readonly string[];
  evidence: readonly Evidence[];
  previousHypotheses: readonly Hypothesis[];
  failedActions: readonly ActionResult[];
  availableTools: readonly ToolDescriptor[];
}

export interface AIReasoningResult {
  decision: AIReasoningDecision;
  hypothesis: string;
  confidence: number;
  reasoningSummary: string;
  informationNeeded: string[];
  recommendedTool: string | null;
  toolArguments: JsonValue | null;
  recommendedAction: string | null;
  expectedResult: string | null;
  risk: RiskLevel | null;
  approvalMayBeRequired: boolean;
}

export interface AIReasoner {
  analyze(input: AIReasonerInput): AIReasoningResult | Promise<AIReasoningResult>;
}

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === 'object' && Object.values(value as Record<string, unknown>).every(isJsonValue);
};

export const isAIReasoningDecision = (value: unknown): value is AIReasoningDecision =>
  typeof value === 'string' && Object.values(AIReasoningDecision).includes(value as AIReasoningDecision);

export const validateAIReasoningResult = (value: unknown): { valid: boolean; errors: string[]; result?: AIReasoningResult } => {
  if (!value || typeof value !== 'object') return { valid: false, errors: ['AI provider returned a non-object result.'] };
  const candidate = value as Record<string, unknown>;
  const errors: string[] = [];
  if (!isAIReasoningDecision(candidate.decision)) errors.push('AI decision is not a supported lifecycle decision.');
  if (typeof candidate.hypothesis !== 'string') errors.push('AI hypothesis must be a string.');
  if (typeof candidate.confidence !== 'number' || candidate.confidence < 0 || candidate.confidence > 1) errors.push('AI confidence must be a number between 0 and 1.');
  if (typeof candidate.reasoningSummary !== 'string') errors.push('AI reasoningSummary must be a string.');
  if (!Array.isArray(candidate.informationNeeded) || !candidate.informationNeeded.every((item) => typeof item === 'string')) errors.push('AI informationNeeded must be an array of strings.');
  if (candidate.recommendedTool !== null && typeof candidate.recommendedTool !== 'string') errors.push('AI recommendedTool must be a string or null.');
  if (candidate.toolArguments !== null && !isJsonValue(candidate.toolArguments)) errors.push('AI toolArguments must be JSON or null.');
  if (candidate.recommendedAction !== null && typeof candidate.recommendedAction !== 'string') errors.push('AI recommendedAction must be a string or null.');
  if (candidate.expectedResult !== null && typeof candidate.expectedResult !== 'string') errors.push('AI expectedResult must be a string or null.');
  if (candidate.risk !== null && !Object.values(RiskLevel).includes(candidate.risk as RiskLevel)) errors.push('AI risk must be a supported risk level or null.');
  if (typeof candidate.approvalMayBeRequired !== 'boolean') errors.push('AI approvalMayBeRequired must be a boolean.');
  if (errors.length) return { valid: false, errors };
  return { valid: true, errors, result: candidate as unknown as AIReasoningResult };
};

export class CallbackAIReasoner implements AIReasoner {
  constructor(private readonly callback: (input: AIReasonerInput) => AIReasoningResult | Promise<AIReasoningResult>) {}

  analyze(input: AIReasonerInput): AIReasoningResult | Promise<AIReasoningResult> {
    return this.callback(input);
  }
}

export const createAIReasonerInput = (
  state: InvestigationState,
  availableTools: readonly ToolDescriptor[],
): AIReasonerInput => ({
  userProblem: state.userProblem,
  state,
  observations: state.observations,
  evidence: state.evidence,
  previousHypotheses: state.hypotheses,
  failedActions: (state.actionHistory ?? []).filter((action) => !action.success),
  availableTools,
});
