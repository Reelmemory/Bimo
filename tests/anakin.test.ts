import { describe, expect, it, vi } from 'vitest';
import {
  AgentRuntime,
  AnakinConfigurationError,
  AnakinResearchClient,
  AnakinResearchTool,
  CallbackPlanner,
  DeploymentDiagnosticsTool,
  EvidenceSource,
  EvidenceType,
  InvestigationStatus,
  RiskLevel,
  ToolRegistry,
  ToolVerifier,
  VerificationStatus,
  createAnakinDeploymentDemoRuntime,
  createAnakinResearchClient,
  type ResearchProvider,
} from '../src/index.js';

const context = {
  investigationId: 'investigation-test',
  userProblem: 'Vercel deployment build error',
  evidence: [],
  recoveryAttempts: 0,
};

const provider = (overrides: Partial<ResearchProvider> = {}): ResearchProvider => ({
  search: vi.fn(async (query: string) => ({
    query,
    results: [{ url: 'https://vercel.com/docs/errors', title: 'Build errors', snippet: 'Check dependency lockfiles.' }],
  })),
  research: vi.fn(async (query: string) => ({
    query,
    summary: 'Research summary',
    structuredData: { cause: 'dependency mismatch' },
    sources: [{ url: 'https://vercel.com/docs/errors', title: 'Build errors' }],
  })),
  ...overrides,
});

describe('Anakin integration and real investigation tools', () => {
  it('configures the official SDK adapter without exposing the SDK to the runtime', async () => {
    const sdk = {
      search: vi.fn(async () => ({ id: 'search-1', results: [{ url: 'https://example.com', title: 'Example' }] })),
      agenticSearch: vi.fn(async () => ({
        id: 'research-1',
        status: 'completed' as const,
        generatedJson: { summary: 'Done', structured_data: { answer: 'yes' } },
      })),
    };
    const client = createAnakinResearchClient({ apiKey: 'test-key', sdkClient: sdk });

    const result = await client.search('known error');

    expect(result.results[0]?.url).toBe('https://example.com');
    expect(sdk.search).toHaveBeenCalledWith('known error', undefined);
  });

  it('fails clearly when ANAKIN_API_KEY is missing', () => {
    const previous = process.env.ANAKIN_API_KEY;
    delete process.env.ANAKIN_API_KEY;
    try {
      expect(() => createAnakinResearchClient()).toThrow(AnakinConfigurationError);
    } finally {
      if (previous === undefined) delete process.env.ANAKIN_API_KEY;
      else process.env.ANAKIN_API_KEY = previous;
    }
  });

  it('normalizes search and deep research into provider-neutral structured results', async () => {
    const sdk = {
      search: vi.fn(async () => ({ id: 's', results: [{ url: 'https://docs.example/error', title: 'Error docs', snippet: 'Fix it.' }] })),
      agenticSearch: vi.fn(async () => ({
        id: 'a',
        status: 'completed' as const,
        generatedJson: {
          summary: 'Multiple sources agree.',
          structured_data: { sources: [{ url: 'https://docs.example/error', title: 'Error docs' }] },
        },
      })),
    };
    const client = new AnakinResearchClient(sdk);

    const search = await client.search('error');
    const deep = await client.research('complex error');

    expect(search.results[0]?.snippet).toBe('Fix it.');
    expect(deep.summary).toBe('Multiple sources agree.');
    expect(deep.sources[0]?.url).toBe('https://docs.example/error');
    expect(deep.structuredData).toEqual({ sources: [{ url: 'https://docs.example/error', title: 'Error docs' }] });
  });

  it('returns structured Anakin evidence with source references', async () => {
    const tool = new AnakinResearchTool(provider());

    const result = await tool.execute({ query: 'Vercel dependency build error' }, context);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ mode: 'search', resultCount: 1 });
    expect(result.evidence?.[0]).toMatchObject({
      source: EvidenceSource.ANAKIN,
      type: EvidenceType.RESEARCH,
      url: 'https://vercel.com/docs/errors',
    });
    expect(result.sources?.[0]?.url).toBe('https://vercel.com/docs/errors');
  });

  it('converts Anakin failures into a failed tool result', async () => {
    const tool = new AnakinResearchTool(provider({
      search: vi.fn(async () => { throw new Error('network unavailable'); }),
    }));

    const result = await tool.execute({ query: 'error' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('network unavailable');
  });

  it('normalizes deployment input and adds user plus Anakin evidence', async () => {
    const tool = new DeploymentDiagnosticsTool(provider());

    const result = await tool.execute({
      deploymentUrl: 'https://app.vercel.app',
      errorMessage: 'Module not found: foo',
      framework: 'Next.js',
      packageManager: 'npm',
    }, context);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ researched: true, researchMode: 'search' });
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence?.[0]).toMatchObject({ source: EvidenceSource.USER, type: EvidenceType.DEPLOYMENT_CONTEXT });
    expect(result.evidence?.[1]).toMatchObject({ source: EvidenceSource.ANAKIN, url: 'https://vercel.com/docs/errors' });
  });

  it('leaves failed external research as a tool failure without throwing', async () => {
    const tool = new DeploymentDiagnosticsTool(provider({
      search: vi.fn(async () => { throw new Error('Anakin timeout'); }),
    }));

    const result = await tool.execute({ errorMessage: 'Build failed' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Anakin timeout');
    expect(result.evidence?.[0]?.source).toBe(EvidenceSource.USER);
  });

  it('executes read-only Anakin research without requesting approval', async () => {
    const research = new AnakinResearchTool(provider());
    const registry = new ToolRegistry();
    registry.register(research);
    const approval = vi.fn(async () => ({ approved: true }));
    const runtime = new AgentRuntime({
      registry,
      reasoner: { analyze: (state) => ({ hypothesis: { id: 'h', statement: `evidence=${state.evidence.length}` } }) },
      planner: new CallbackPlanner((state) => state.status === InvestigationStatus.READING
        ? { id: 'p-read', objective: 'research', actions: [{ id: 'a-read', toolName: 'anakin_research', input: { query: 'error' } }] }
        : null),
      verifier: new ToolVerifier({ toolName: 'anakin_research' }),
      approvalProvider: { requestApproval: approval },
    });

    const result = await runtime.investigate('research this error');

    expect(research.riskLevel).toBe(RiskLevel.READ_ONLY);
    expect(approval).not.toHaveBeenCalled();
    expect(result.evidence.some((item) => item.source === EvidenceSource.ANAKIN)).toBe(true);
  });

  it('passes the current evidence to the planner', async () => {
    const research = new AnakinResearchTool(provider());
    const registry = new ToolRegistry();
    registry.register(research);
    const plannedEvidenceCounts: number[] = [];
    const runtime = new AgentRuntime({
      registry,
      reasoner: { analyze: () => ({ hypothesis: { id: 'h', statement: 'research complete' } }) },
      planner: new CallbackPlanner((state) => {
        plannedEvidenceCounts.push(state.evidence.length);
        return state.status === InvestigationStatus.READING
          ? { id: 'p', objective: 'research', actions: [{ id: 'a', toolName: 'anakin_research', input: { query: 'error' } }] }
          : null;
      }),
      verifier: new ToolVerifier({ toolName: 'anakin_research' }),
    });

    await runtime.investigate('research this error');

    expect(plannedEvidenceCounts[0]).toBe(1);
    expect(plannedEvidenceCounts[1]).toBeGreaterThan(1);
  });

  it('completes the mocked Anakin deployment flow', async () => {
    const mockedProvider = provider();
    const runtime = createAnakinDeploymentDemoRuntime(mockedProvider);

    const result = await runtime.investigate('My Vercel deployment is failing with a build error.');

    expect(mockedProvider.search).toHaveBeenCalled();
    expect(result.status).toBe(InvestigationStatus.COMPLETED);
    expect(result.evidence.some((item) => item.source === EvidenceSource.ANAKIN)).toBe(true);
    expect(result.evidence.some((item) => item.source === EvidenceSource.USER)).toBe(true);
    expect(result.finalResult?.outcome).toBe('SUCCESS');
    expect(result.verification?.status).toBe(VerificationStatus.PASSED);
  });
});
