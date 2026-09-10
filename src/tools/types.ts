import type { Evidence, InvestigationState, JsonValue, SourceReference } from '../types/investigation.js';

export enum RiskLevel {
  READ_ONLY = 'READ_ONLY',
  REVERSIBLE = 'REVERSIBLE',
  CONSEQUENTIAL = 'CONSEQUENTIAL',
}

export interface ToolInputProperty {
  type: string;
  description?: string;
  enum?: JsonValue[];
}

export interface ToolInputDefinition {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array' | 'null';
  description?: string;
  properties?: Record<string, ToolInputProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  inputDefinition: ToolInputDefinition;
}

export interface ToolExecutionContext {
  investigationId: string;
  userProblem: string;
  evidence: readonly Evidence[];
  recoveryAttempts: number;
}

export interface ToolExecutionResult<TOutput extends JsonValue = JsonValue> {
  success: boolean;
  summary?: string;
  data?: JsonValue;
  output?: TOutput;
  error?: string;
  evidence?: Evidence[];
  sources?: SourceReference[];
}

export interface Tool<TInput = JsonValue, TOutput extends JsonValue = JsonValue> {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  inputDefinition: ToolInputDefinition;
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolExecutionResult<TOutput>>;
}
