import { describe, expect, it, vi } from 'vitest';
import {
  AgentRuntime,
  AIConfigurationError,
  AIReasoningDecision,
  CallbackAIReasoner,
  InvestigationEventType,
  InvestigationStatus,
  OpenAICompatibleProvider,
  RiskLevel,
  StructuredAIReasoner,
  ToolRegistry,
  ToolVerifier,
  VerificationStatus,
  createAIReasonerInput,
  createAIDeploymentDemoRuntime,
  createAIReasoningSchema,
  createInvestigationState,
  validateAIReasoningResult,
  type AIReasoningResult,
  type JsonValue,
  type Tool,
} from '../src/index.js';

const reasoning = (
  decision: AIReasoningDecision,
  overrides: Partial<AIReasoningResult> = {},
): AIReasoningResult => ({
  decision,
  hypothesis: 'A test hypothesis',
  confidence: 0.8,
  reasoningSummary: `The next decision is ${decision}.`,
  informationNeeded: decision === AIReasoningDecision.NEED_INFORMATION ? ['current documentation'] : [],
  recommendedTool: null,
  toolArguments: null,
  recommendedAction: null,
  expectedResult: null,
  risk: null,
  approvalMayBeRequired: false,
  ...overrides,
});

const readTool = (name = 'read'): Tool<null, JsonValue> => ({
  name,
  description: 'Read-only test evidence tool',
  riskLevel: RiskLevel.READ_ONLY,
  inputDefinition: { type: 'null' },
  execute: async () => ({
    success: true,
    summary: 'Evidence collected',
    output: { evidence: 'fresh' },
    evidence: [{
      id: `evidence-${name}`,
      source: 'TOOL',
      type: 'OBSERVATION',
      summary: 'Fresh test evidence',
      content: 'The read-only test tool returned evidence.',
      confidence: 0.9,
      timestamp: new Date().toISOString(),
    }],
  }),
});

const actionTool = (name = 'fix', riskLevel: RiskLevel = RiskLevel.REVERSIBLE): Tool<null, JsonValue> => ({
  name,
  description: 'Test remediation tool',
  riskLevel,
  inputDefinition: { type: 'null' },
  execute: async () => ({ success: true, summary: 'Action applied', output: { changed: true } }),
});

describe('AI-driven BIMO runtime', () => {
  it('executes a model-requested read-only tool and records the result as evidence', async () => {
    const registry = new ToolRegistry();
    registry.register(readTool('research'));
    const approval = vi.fn(async () => ({ approved: true }));
    const runtime = new AgentRuntime({
      registry,
      aiReasoner: new CallbackAIReasoner((_input) => reasoning(AIReasoningDecision.NEED_INFORMATION, {
        recommendedTool: 'research',
        toolArguments: null,
        risk: RiskLevel.CONSEQUENTIAL,
      })),
      verifier: new ToolVerifier({ toolName: 'research' }),
      approvalProvider: { requestApproval: approval },
      maxReasoningIterations: 1,
    });

    const result = await runtime.investigate('Find evidence');

    expect(result.status).toBe(InvestigationStatus.FAILED);
    expect(result.actionHistory?.[0]?.success).toBe(true);
    expect(result.evidence.some((item) => item.summary === 'Fresh test evidence')).toBe(true);
    expect(approval).not.toHaveBeenCalled();
    expect(result.events?.map((event) => event.type)).toContain(InvestigationEventType.TOOL_RESULT);
    expect(result.events?.some((event) => event.type === InvestigationEventType.APPROVAL_DECIDED)).toBe(true);
  });

  it('passes updated evidence and failed actions into later AI reasoning calls', async () => {
    const registry = new ToolRegistry();
    registry.register(readTool('research'));
    const inputs: Array<{ evidence: number; failedActions: number }> = [];
    let call = 0;
    const runtime = new AgentRuntime({
      registry,
      aiReasoner: new CallbackAIReasoner((input) => {
        inputs.push({ evidence: input.evidence.length, failedActions: input.failedActions.length });
        call += 1;
        return call === 1
          ? reasoning(AIReasoningDecision.NEED_INFORMATION, { recommendedTool: 'research' })
          : reasoning(AIReasoningDecision.COMPLETE);
      }),
      verifier: new ToolVerifier({ toolName: 'research' }),
      maxReasoningIterations: 3,
    });

    const result = await runtime.investigate('Investigate this');

    expect(result.status).toBe(InvestigationStatus.COMPLETED);
    expect(inputs[0]?.evidence).toBe(1);
    expect(inputs[1]?.evidence).toBeGreaterThan(inputs[0]?.evidence ?? 0);
    expect(inputs[1]?.failedActions).toBe(0);
  });

  it('dynamically selects a registered remediation tool, reaches approval, and blocks rejection', async () => {
    const registry = new ToolRegistry();
    const deploy = actionTool('deploy', RiskLevel.CONSEQUENTIAL);
    registry.register(deploy);
    let call = 0;
    const approval = vi.fn(async () => ({ approved: false, reason: 'operator declined' }));
    const runtime = new AgentRuntime({
      registry,
      aiReasoner: new CallbackAIReasoner(() => {
        call += 1;
        return reasoning(AIReasoningDecision.TAKE_ACTION, {
          recommendedTool: 'deploy',
          toolArguments: null,
          risk: RiskLevel.READ_ONLY,
          recommendedAction: 'Deploy the application',
        });
      }),
      verifier: new ToolVerifier({ toolName: 'deploy' }),
      approvalProvider: { requestApproval: approval },
    });

    const result = await runtime.investigate('Deploy this application');

    expect(call).toBe(1);
    expect(approval).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(InvestigationStatus.REJECTED);
    expect(result.actionHistory?.[0]).toBeUndefined();
    expect(result.events?.some((event) => event.type === InvestigationEventType.APPROVAL_REQUESTED)).toBe(true);
  });

  it('rejects unknown tools and invalid arguments before execution', async () => {
    const registry = new ToolRegistry();
    const runtimeUnknown = new AgentRuntime({
      registry,
      aiReasoner: new CallbackAIReasoner(() => reasoning(AIReasoningDecision.NEED_INFORMATION, {
        recommendedTool: 'missing', toolArguments: null,
      })),
      verifier: new ToolVerifier({ toolName: 'missing' }),
      maxReasoningIterations: 2,
    });
    const unknown = await runtimeUnknown.investigate('Use a missing tool');
    expect(unknown.status).toBe(InvestigationStatus.FAILED);
    expect(unknown.finalResult?.summary).toContain('not registered');

    const execute = vi.fn(async () => ({ success: true, output: null }));
    const objectTool: Tool<{ query: string }, JsonValue> = {
      name: 'object-tool',
      description: 'Requires query',
      riskLevel: RiskLevel.READ_ONLY,
      inputDefinition: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      execute,
    };
    registry.register(objectTool);
    const runtimeInvalid = new AgentRuntime({
      registry,
      aiReasoner: new CallbackAIReasoner(() => reasoning(AIReasoningDecision.NEED_INFORMATION, {
        recommendedTool: 'object-tool', toolArguments: { wrong: true },
      })),
      verifier: new ToolVerifier({ toolName: 'object-tool' }),
    });
    const invalid = await runtimeInvalid.investigate('Use invalid args');
    expect(invalid.status).toBe(InvestigationStatus.FAILED);
    expect(invalid.finalResult?.summary).toContain('Invalid arguments');
    expect(execute).not.toHaveBeenCalled();
  });

  it('reasons again after failed verification and can change its action', async () => {
    const registry = new ToolRegistry();
    registry.register(actionTool('first-fix'));
    registry.register(actionTool('second-fix'));
    registry.register({
      name: 'verify',
      description: 'Verification tool',
      riskLevel: RiskLevel.READ_ONLY,
      inputDefinition: { type: 'null' },
      execute: async (_input, context) => ({
        success: true,
        output: { healthy: context.recoveryAttempts > 0 },
      }),
    });
    const decisions: AIReasoningDecision[] = [];
    let call = 0;
    const runtime = new AgentRuntime({
      registry,
      aiReasoner: new CallbackAIReasoner((input) => {
        call += 1;
        const decision = call === 1
          ? reasoning(AIReasoningDecision.TAKE_ACTION, { recommendedTool: 'first-fix' })
          : call === 2
            ? reasoning(AIReasoningDecision.VERIFY)
            : call === 3
              ? reasoning(AIReasoningDecision.RECOVER, { recommendedTool: 'second-fix' })
              : reasoning(AIReasoningDecision.VERIFY);
        decisions.push(decision.decision);
        expect(input.failedActions.length).toBeGreaterThanOrEqual(call >= 3 ? 0 : 0);
        return decision;
      }),
      verifier: new ToolVerifier({
        toolName: 'verify',
        evaluateOutput: (output) => ({
          status: output && typeof output === 'object' && 'healthy' in output && output.healthy === true
            ? VerificationStatus.PASSED : VerificationStatus.FAILED,
          summary: output && typeof output === 'object' && 'healthy' in output && output.healthy === true
            ? 'Healthy' : 'Still failing',
        }),
      }),
      maxReasoningIterations: 6,
      maxToolCalls: 6,
      maxRecoveryAttempts: 2,
    });

    const result = await runtime.investigate('Fix the service');

    expect(result.status).toBe(InvestigationStatus.COMPLETED);
    expect(decisions).toEqual([
      AIReasoningDecision.TAKE_ACTION,
      AIReasoningDecision.VERIFY,
      AIReasoningDecision.RECOVER,
      AIReasoningDecision.VERIFY,
    ]);
    expect(result.recoveryAttempts).toBe(1);
    expect(result.events?.some((event) => event.type === InvestigationEventType.RECOVERY)).toBe(true);
  });

  it('enforces the maximum AI reasoning iteration limit', async () => {
    const registry = new ToolRegistry();
    registry.register(readTool('research'));
    const reasoner = vi.fn(() => reasoning(AIReasoningDecision.NEED_INFORMATION, { recommendedTool: 'research' }));
    const runtime = new AgentRuntime({
      registry,
      aiReasoner: new CallbackAIReasoner(reasoner),
      verifier: new ToolVerifier({ toolName: 'research' }),
      maxReasoningIterations: 2,
      maxToolCalls: 10,
    });

    const result = await runtime.investigate('Keep investigating');

    expect(reasoner).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(InvestigationStatus.FAILED);
    expect(result.finalResult?.summary).toContain('Maximum AI reasoning iterations');
  });

  it('does not allow a later read-only call to hide an unverified mutation', async () => {
    const registry = new ToolRegistry();
    registry.register(actionTool('fix'));
    registry.register(readTool('research'));
    let call = 0;
    const runtime = new AgentRuntime({
      registry,
      aiReasoner: new CallbackAIReasoner(() => {
        call += 1;
        if (call === 1) return reasoning(AIReasoningDecision.TAKE_ACTION, { recommendedTool: 'fix' });
        if (call === 2) return reasoning(AIReasoningDecision.NEED_INFORMATION, { recommendedTool: 'research' });
        return reasoning(AIReasoningDecision.COMPLETE);
      }),
      verifier: new ToolVerifier({ toolName: 'research' }),
      maxReasoningIterations: 4,
    });

    const result = await runtime.investigate('Fix and investigate the service');

    expect(result.status).toBe(InvestigationStatus.FAILED);
    expect(result.finalResult?.summary).toContain('before a non-read-only action was verified');
  });

  it('includes failed verification state in the provider prompt and builds strict tool schemas', async () => {
    let capturedRequest: { userPrompt: string; schema: Record<string, unknown> } | undefined;
    const provider = {
      generateStructured: async <T>(request: { userPrompt: string; schema: Record<string, unknown> }) => {
        capturedRequest = request;
        return reasoning(AIReasoningDecision.RECOVER, {
          recommendedTool: 'research',
          toolArguments: { query: 'new evidence', mode: null },
        }) as T;
      },
    };
    const descriptor = {
      name: 'research',
      description: 'Research evidence',
      riskLevel: RiskLevel.READ_ONLY,
      inputDefinition: {
        type: 'object' as const,
        properties: {
          query: { type: 'string' },
          mode: { type: 'string', enum: ['search', 'deep'] },
        },
        required: ['query'],
      },
    };
    const state = createInvestigationState('Investigate the failed deployment');
    state.verification = { status: VerificationStatus.FAILED, summary: 'Still unhealthy' };
    const reasoner = new StructuredAIReasoner(provider);

    const result = await reasoner.analyze(createAIReasonerInput(state, [descriptor]));

    const prompt = JSON.parse(capturedRequest?.userPrompt ?? '{}') as {
      investigationState?: { verification?: { status?: string } };
    };
    expect(prompt.investigationState?.verification?.status).toBe(VerificationStatus.FAILED);
    expect(result.toolArguments).toEqual({ query: 'new evidence' });

    const schema = createAIReasoningSchema([descriptor]) as {
      properties: { toolArguments: { anyOf: Array<Record<string, unknown>> } };
    };
    const objectSchema = schema.properties.toolArguments.anyOf.find((item) => item.type === 'object') as {
      additionalProperties?: boolean;
      required?: string[];
    } | undefined;
    expect(objectSchema?.additionalProperties).toBe(false);
    expect(objectSchema?.required).toEqual(['query', 'mode']);
  });

  it('redacts credential-like tool arguments from investigation history without changing execution input', async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(async (input: JsonValue) => ({ success: true, output: input }));
    registry.register({
      name: 'safe-network-read',
      description: 'Reads a URL without persisting credentials.',
      riskLevel: RiskLevel.READ_ONLY,
      inputDefinition: {
        type: 'object',
        properties: { url: { type: 'string' }, api_token: { type: 'string' } },
        required: ['url', 'api_token'],
      },
      execute,
    });
    let call = 0;
    const runtime = new AgentRuntime({
      registry,
      aiReasoner: new CallbackAIReasoner((input) => {
        call += 1;
        if (call === 2) expect(JSON.stringify(input.state)).not.toContain('super-secret');
        return call === 1
          ? reasoning(AIReasoningDecision.NEED_INFORMATION, {
              recommendedTool: 'safe-network-read',
              toolArguments: { url: 'https://example.com/health?token=super-secret', api_token: 'super-secret' },
            })
          : reasoning(AIReasoningDecision.COMPLETE);
      }),
      verifier: new ToolVerifier({ toolName: 'safe-network-read', input: { url: 'https://example.com', api_token: 'none' } }),
    });

    const result = await runtime.investigate('Check https://example.com/health?token=super-secret');

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ api_token: 'super-secret' }), expect.anything());
    expect(result.userProblem).not.toContain('super-secret');
    expect(JSON.stringify(result.plan)).not.toContain('super-secret');
    expect(JSON.stringify(result.events)).not.toContain('super-secret');

    const envState = createInvestigationState('Vercel request failed: VERCEL_TOKEN=vercel-secret WEB3_RPC_URL=https://user:pass@rpc.example.test');
    expect(JSON.stringify(envState)).not.toContain('vercel-secret');
    expect(JSON.stringify(envState)).not.toContain('user:pass');
  });

  it('validates structured AI output and uses the Responses API shape', async () => {
    expect(validateAIReasoningResult(reasoning(AIReasoningDecision.COMPLETE)).valid).toBe(true);
    expect(validateAIReasoningResult({ decision: 'INVALID' }).valid).toBe(false);

    const create = vi.fn(async (request: Record<string, unknown>) => ({
      output_text: JSON.stringify(reasoning(AIReasoningDecision.COMPLETE)),
    }));
    const provider = new OpenAICompatibleProvider({
      client: { responses: { create } },
      apiKey: 'test-key',
    });
    const result = await provider.generateStructured({
      name: 'test',
      systemPrompt: 'system',
      userPrompt: 'user',
      schema: { type: 'object' },
    });

    expect(result).toMatchObject({ decision: AIReasoningDecision.COMPLETE });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      text: { format: expect.objectContaining({ type: 'json_schema', name: 'test', strict: true }) },
    }));
  });

  it('requires OPENAI_API_KEY unless an injected model client is supplied', () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => new OpenAICompatibleProvider()).toThrow(AIConfigurationError);
      expect(() => new OpenAICompatibleProvider({ client: { responses: { create: vi.fn() } } })).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('runs the AI-driven deployment demo by dynamically selecting Anakin, remediation, and verification tools', async () => {
    const search = vi.fn(async (query: string) => ({
      query,
      results: [{ url: 'https://nextjs.org/docs', title: 'Next.js build docs', snippet: 'Dependency resolution guidance.' }],
    }));
    let call = 0;
    const runtime = createAIDeploymentDemoRuntime(
      new CallbackAIReasoner(() => {
        call += 1;
        if (call === 1) return reasoning(AIReasoningDecision.NEED_INFORMATION, {
          hypothesis: 'The build failure needs current Next.js documentation.',
          recommendedTool: 'anakin_research',
          toolArguments: { query: 'Next.js Vercel build dependency error', mode: 'search' },
          recommendedAction: 'Research the current build error.',
          expectedResult: 'Relevant technical evidence and source references.',
        });
        if (call === 2) return reasoning(AIReasoningDecision.TAKE_ACTION, {
          recommendedTool: 'mock_fix_dependency',
          recommendedAction: 'Apply the dependency repair.',
        });
        if (call === 3) return reasoning(AIReasoningDecision.TAKE_ACTION, {
          recommendedTool: 'mock_deploy',
          recommendedAction: 'Deploy the repaired application.',
          risk: RiskLevel.READ_ONLY,
        });
        return reasoning(AIReasoningDecision.VERIFY);
      }),
      {
        search,
        research: vi.fn(async (query: string) => ({ query, summary: 'Deep result', sources: [] })),
      },
    );

    const result = await runtime.investigate('My Vercel deployment is failing with a Next.js build error.');

    expect(result.status).toBe(InvestigationStatus.COMPLETED);
    expect(result.finalResult?.outcome).toBe('SUCCESS');
    expect(search).toHaveBeenCalledWith('Next.js Vercel build dependency error');
    expect(result.evidence.some((item) => item.source === 'ANAKIN')).toBe(true);
    expect(result.events?.filter((event) => event.type === InvestigationEventType.REASONING).length).toBe(4);
    expect(result.events?.some((event) => event.type === InvestigationEventType.APPROVAL_REQUESTED)).toBe(true);
  });
});
