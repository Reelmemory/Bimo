import type { AIReasoner, AIReasonerInput, AIReasoningResult } from './ai-reasoner.js';
import { validateAIReasoningResult } from './ai-reasoner.js';
import type { StructuredOutputProvider } from '../integrations/ai/types.js';
import { OpenAICompatibleProvider, type OpenAICompatibleProviderOptions } from '../integrations/ai/openai-compatible.js';
import type { JsonValue } from '../types/investigation.js';
import type { ToolDescriptor, ToolInputDefinition, ToolInputProperty } from '../tools/types.js';

type JsonSchema = Record<string, unknown>;

const scalarSchema = (type: string, enumValues?: JsonValue[]): JsonSchema => {
  const schema: JsonSchema = type === 'integer' ? { type: 'integer' } : { type };
  if (enumValues?.length) schema.enum = enumValues;
  return schema;
};

const propertySchema = (property: ToolInputProperty): JsonSchema => {
  if (property.type === 'object') {
    return { type: 'object', additionalProperties: false, properties: {}, required: [] };
  }
  if (property.type === 'array') {
    return {
      type: 'array',
      items: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] },
    };
  }
  return scalarSchema(property.type, property.enum);
};

const strictToolInputSchema = (definition: ToolInputDefinition): JsonSchema => {
  if (definition.type !== 'object') return scalarSchema(definition.type);
  const requiredByTool = new Set(definition.required ?? []);
  const properties = Object.fromEntries(Object.entries(definition.properties ?? {}).map(([name, property]) => {
    const schema = propertySchema(property);
    return [name, requiredByTool.has(name) ? schema : { anyOf: [schema, { type: 'null' }] }];
  }));
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  };
};

const uniqueSchemas = (schemas: JsonSchema[]): JsonSchema[] =>
  [...new Map(schemas.map((schema) => [JSON.stringify(schema), schema])).values()];

export const createAIReasoningSchema = (tools: readonly ToolDescriptor[]): JsonSchema => {
  const toolNames = tools.map((tool) => tool.name);
  const argumentSchemas = uniqueSchemas([
    ...tools.map((tool) => strictToolInputSchema(tool.inputDefinition)),
    { type: 'null' },
  ]);
  return {
  type: 'object',
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['NEED_INFORMATION', 'TAKE_ACTION', 'VERIFY', 'COMPLETE', 'RECOVER'] },
    hypothesis: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reasoningSummary: { type: 'string' },
    informationNeeded: { type: 'array', items: { type: 'string' } },
    recommendedTool: toolNames.length
      ? { anyOf: [{ type: 'string', enum: toolNames }, { type: 'null' }] }
      : { type: 'null' },
    toolArguments: { anyOf: argumentSchemas },
    recommendedAction: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    expectedResult: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    risk: {
      anyOf: [
        { type: 'string', enum: ['READ_ONLY', 'REVERSIBLE', 'CONSEQUENTIAL'] },
        { type: 'null' },
      ],
    },
    approvalMayBeRequired: { type: 'boolean' },
  },
  required: [
    'decision',
    'hypothesis',
    'confidence',
    'reasoningSummary',
    'informationNeeded',
    'recommendedTool',
    'toolArguments',
    'recommendedAction',
    'expectedResult',
    'risk',
    'approvalMayBeRequired',
  ],
  };
};

export const AI_REASONING_SCHEMA: JsonSchema = createAIReasoningSchema([]);

const normalizeToolArguments = (
  value: JsonValue | null,
  selectedTool: ToolDescriptor | undefined,
): JsonValue | null => {
  if (!selectedTool || selectedTool.inputDefinition.type !== 'object' || value === null
    || typeof value !== 'object' || Array.isArray(value)) return value;
  const required = new Set(selectedTool.inputDefinition.required ?? []);
  return Object.fromEntries(Object.entries(value).filter(([name, item]) => item !== null || required.has(name)));
};

const SYSTEM_PROMPT = `You are BIMO's technical operations reasoning component.
Return only the supplied JSON schema. You propose investigation steps; BIMO validates every tool, argument, risk, approval, execution, and verification decision.
Choose NEED_INFORMATION when evidence is insufficient and select exactly one registered read-only tool.
Choose TAKE_ACTION when a registered remediation tool is justified.
Choose VERIFY when the current state should be checked by BIMO's verifier.
Choose RECOVER after a failed verification when the hypothesis or next step must change.
Choose COMPLETE only when the evidence supports a final answer.
Never invent tools. Use only the available tool descriptors and their input schemas.`;

export class StructuredAIReasoner implements AIReasoner {
  constructor(private readonly provider: StructuredOutputProvider) {}

  async analyze(input: AIReasonerInput): Promise<AIReasoningResult> {
    const result = await this.provider.generateStructured<unknown>({
      name: 'bimo_investigation_reasoning',
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: JSON.stringify({
        userProblem: input.userProblem,
        investigationState: {
          status: input.state.status,
          currentHypothesis: input.state.currentHypothesis,
          plan: input.state.plan,
          currentAction: input.state.currentAction,
          actionResult: input.state.actionResult,
          verification: input.state.verification,
          approval: input.state.approval,
          recoveryAttempts: input.state.recoveryAttempts,
          actionHistory: input.state.actionHistory,
          events: input.state.events,
        },
        observations: input.observations,
        evidence: input.evidence,
        previousHypotheses: input.previousHypotheses,
        failedActions: input.failedActions,
        availableTools: input.availableTools,
      }),
      schema: createAIReasoningSchema(input.availableTools),
    });
    if (result && typeof result === 'object') {
      const candidate = result as Record<string, unknown>;
      const recommendedTool = typeof candidate.recommendedTool === 'string'
        ? input.availableTools.find((tool) => tool.name === candidate.recommendedTool)
        : undefined;
      candidate.toolArguments = normalizeToolArguments(candidate.toolArguments as JsonValue | null, recommendedTool);
    }
    const validation = validateAIReasoningResult(result);
    if (!validation.valid || !validation.result) {
      throw new Error(`AI reasoning output failed validation: ${validation.errors.join(' ')}`);
    }
    return validation.result;
  }
}

export const createOpenAICompatibleReasoner = (options: OpenAICompatibleProviderOptions = {}) =>
  new StructuredAIReasoner(new OpenAICompatibleProvider(options));
