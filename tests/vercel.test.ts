import { describe, expect, it, vi } from 'vitest';
import {
  AIReasoningDecision,
  AgentRuntime,
  CallbackAIReasoner,
  EvidenceSource,
  InvestigationEventType,
  InvestigationStatus,
  RiskLevel,
  ToolRegistry,
  ToolVerifier,
  VercelCheckDeploymentTool,
  VercelClient,
  VercelConfigurationError,
  VercelGetDeploymentLogsTool,
  VercelGetDeploymentTool,
  VercelProviderError,
  VercelRedeployTool,
  VercelRollbackTool,
  VerificationStatus,
  PermissionDecision,
  createVercelClient,
  type AIReasoningResult,
  type NetworkDiagnosticsProvider,
  type VercelDeployment,
  type VercelProvider,
} from '../src/index.js';

const context = {
  investigationId: 'investigation-vercel',
  userProblem: 'Deployment is broken',
  evidence: [],
  recoveryAttempts: 0,
};

const deployment = (overrides: Partial<VercelDeployment> = {}): VercelDeployment => ({
  id: 'dpl_123',
  url: 'example.vercel.app',
  status: 'READY',
  name: 'example',
  projectId: 'prj_123',
  project: { id: 'prj_123', name: 'example', framework: 'nextjs' },
  git: { branch: 'main', commitSha: 'abc123' },
  target: 'production',
  createdAt: '2026-01-01T00:00:00.000Z',
  buildingAt: '2026-01-01T00:00:01.000Z',
  readyAt: '2026-01-01T00:01:00.000Z',
  errorCode: null,
  errorMessage: null,
  errorStep: null,
  regions: ['iad1'],
  metadata: {},
  ...overrides,
});

const provider = (overrides: Partial<VercelProvider> = {}): VercelProvider => ({
  getDeployment: vi.fn(async () => deployment()),
  getDeploymentLogs: vi.fn(async () => []),
  redeploy: vi.fn(async () => deployment({ id: 'dpl_new', status: 'BUILDING' })),
  rollback: vi.fn(async (input) => ({ accepted: true as const, projectId: input.projectId, deploymentId: input.deploymentId })),
  ...overrides,
});

const network = (overrides: Partial<NetworkDiagnosticsProvider> = {}): NetworkDiagnosticsProvider => ({
  httpHealthCheck: vi.fn(async ({ url }) => ({ ok: true, url, finalUrl: url, statusCode: 200, responseTimeMs: 20, redirects: [], headers: {} })),
  dnsLookup: vi.fn(async ({ hostname, recordType }) => ({ hostname, recordType, records: ['203.0.113.1'] })),
  tlsCheck: vi.fn(async ({ hostname, port = 443 }) => ({
    hostname, port, authorized: true, protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384', subject: {}, issuer: {},
    validFrom: null, validTo: null, daysRemaining: null, fingerprint256: null, serialNumber: null, subjectAltName: null,
  })),
  ...overrides,
});

const reasoning = (decision: AIReasoningDecision, overrides: Partial<AIReasoningResult> = {}): AIReasoningResult => ({
  decision,
  hypothesis: 'Vercel deployment needs investigation.',
  confidence: 0.8,
  reasoningSummary: 'Use a registered Vercel operation.',
  informationNeeded: [],
  recommendedTool: null,
  toolArguments: null,
  recommendedAction: null,
  expectedResult: null,
  risk: null,
  approvalMayBeRequired: false,
  ...overrides,
});

describe('Vercel integration and tools', () => {
  it('normalizes deployment lookup through the official SDK boundary', async () => {
    const sdk = {
      deployments: {
        getDeployment: vi.fn(async () => ({
          id: 'dpl_live',
          url: 'live.vercel.app',
          readyState: 'ERROR',
          name: 'live-app',
          projectId: 'prj_live',
          createdAt: 1_700_000_000_000,
          buildingAt: 1_700_000_001_000,
          regions: ['iad1'],
          errorCode: 'BUILD_FAILED',
          errorMessage: 'Module not found',
          errorStep: 'build',
          meta: { githubCommitRef: 'main', githubCommitSha: 'deadbeef', secret: 'must-not-leak' },
        })),
        getDeploymentEvents: vi.fn(),
        createDeployment: vi.fn(),
      },
      projects: { requestRollback: vi.fn() },
    };
    const client = new VercelClient(sdk);

    const result = await client.getDeployment({ deploymentIdOrUrl: 'https://live.vercel.app/path' });

    expect(result).toMatchObject({ id: 'dpl_live', status: 'ERROR', git: { branch: 'main', commitSha: 'deadbeef' } });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(sdk.deployments.getDeployment).toHaveBeenCalledWith(expect.objectContaining({ idOrUrl: 'live.vercel.app', withGitRepoInfo: 'true' }));
  });

  it('normalizes and truncates deployment logs with errors prioritized', async () => {
    const logs = Array.from({ length: 120 }, (_, index) => ({
      id: `log-${index}`,
      timestamp: new Date(index * 1000).toISOString(),
      type: 'stdout',
      level: null,
      text: index === 119 ? 'Build failed: Module not found dependency error API_KEY=must-not-leak' : `normal build output ${index}`,
      step: 'build',
    }));
    const tool = new VercelGetDeploymentLogsTool(provider({ getDeploymentLogs: vi.fn(async () => logs) }));

    const result = await tool.execute({ deploymentIdOrUrl: 'dpl_123', maxEntries: 5 }, context);
    const output = result.output as { logs: Array<{ text: string }>; truncated: boolean; returnedEntries: number };

    expect(result.success).toBe(true);
    expect(output.returnedEntries).toBe(5);
    expect(output.truncated).toBe(true);
    expect(output.logs[0]?.text).toContain('Build failed');
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(result.evidence?.[0]?.content?.length).toBeLessThanOrEqual(12_500);
  });

  it('normalizes deployment aliases through the official SDK boundary', async () => {
    const sdk = {
      deployments: {
        getDeployment: vi.fn(),
        getDeploymentEvents: vi.fn(),
        createDeployment: vi.fn(),
      },
      projects: { requestRollback: vi.fn() },
      aliases: {
        listDeploymentAliases: vi.fn(async () => ({
          aliases: [{ uid: 'alias_1', alias: 'app.example.com', created: 1_700_000_000_000, redirect: null }],
        })),
      },
    };
    const client = new VercelClient(sdk);

    const result = await client.getDeploymentAliases({ deploymentIdOrUrl: 'dpl_123', teamSlug: 'team' });

    expect(result).toEqual([expect.objectContaining({ uid: 'alias_1', alias: 'app.example.com', redirect: null })]);
    expect(sdk.aliases.listDeploymentAliases).toHaveBeenCalledWith({ id: 'dpl_123', slug: 'team' });
  });

  it('verifies deployment state and HTTP health without treating an unhealthy response as provider success', async () => {
    const tool = new VercelCheckDeploymentTool(provider(), network());

    const result = await tool.execute({ deploymentIdOrUrl: 'dpl_123' }, context);

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ healthy: true, deployment: { status: 'READY' }, httpCheck: { statusCode: 200 } });
    expect(result.evidence?.[0]?.source).toBe(EvidenceSource.VERCEL);
  });

  it('requires independent production-routing confirmation when requested', async () => {
    const getDeploymentAliases = vi.fn(async () => [{
      uid: 'alias_1', alias: 'app.example.com', redirect: null, createdAt: null,
    }]);
    const tool = new VercelCheckDeploymentTool(provider({ getDeploymentAliases }), network());

    const result = await tool.execute({
      deploymentIdOrUrl: 'dpl_123',
      expectedDeploymentId: 'dpl_123',
      verifyProductionRouting: true,
    }, context);

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ healthy: true, productionRouting: { checked: true, confirmed: true } });
    expect(getDeploymentAliases).toHaveBeenCalledWith({ deploymentIdOrUrl: 'dpl_123' });
  });

  it('does not claim rollback verification when production routing cannot be confirmed', async () => {
    const tool = new VercelCheckDeploymentTool(provider(), network());

    const result = await tool.execute({
      deploymentIdOrUrl: 'dpl_123',
      expectedDeploymentId: 'dpl_123',
      verifyProductionRouting: true,
    }, context);

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ healthy: false, productionRouting: { checked: true, confirmed: false } });
    expect(result.summary).toContain('production routing was not confirmed');
  });

  it('fails clearly when VERCEL_TOKEN is absent', () => {
    const previous = process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TOKEN;
    try {
      expect(() => createVercelClient()).toThrow(VercelConfigurationError);
    } finally {
      if (previous === undefined) delete process.env.VERCEL_TOKEN;
      else process.env.VERCEL_TOKEN = previous;
    }
  });

  it('converts authentication errors into structured tool failures', async () => {
    const tool = new VercelGetDeploymentTool(provider({
      getDeployment: vi.fn(async () => { throw new VercelProviderError('AUTHENTICATION', 'Vercel authentication failed.'); }),
    }));

    const result = await tool.execute({ deploymentIdOrUrl: 'dpl_123' }, context);

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ code: 'AUTHENTICATION' });
    expect(result.evidence?.[0]).toMatchObject({ source: EvidenceSource.VERCEL });
  });

  it('uses the SDK redeploy and rollback operations without claiming completion', async () => {
    const sdk = {
      deployments: {
        getDeployment: vi.fn(async () => ({ id: 'dpl_old', url: 'old.vercel.app', readyState: 'ERROR', name: 'app', projectId: 'prj_1', regions: [], meta: {} })),
        getDeploymentEvents: vi.fn(),
        createDeployment: vi.fn(async () => ({ id: 'dpl_new', url: 'new.vercel.app', readyState: 'QUEUED', name: 'app', projectId: 'prj_1', regions: [], meta: {} })),
      },
      projects: { requestRollback: vi.fn(async () => undefined) },
    };
    const client = new VercelClient(sdk);

    const redeployed = await client.redeploy({ deploymentIdOrUrl: 'dpl_old' });
    const rolledBack = await client.rollback({ projectId: 'prj_1', deploymentId: 'dpl_previous' });

    expect(redeployed).toMatchObject({ id: 'dpl_new', status: 'QUEUED' });
    expect(sdk.deployments.createDeployment).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: expect.objectContaining({ deploymentId: 'dpl_old', name: 'app', project: 'prj_1' }),
    }));
    expect(rolledBack.accepted).toBe(true);
    expect(sdk.projects.requestRollback).toHaveBeenCalledWith(expect.objectContaining({ deploymentId: 'dpl_previous' }));
  });

  it('routes redeploy through approval and verifies the provider-confirmed deployment', async () => {
    const redeploy = vi.fn(async () => deployment({ id: 'dpl_new', status: 'BUILDING' }));
    const vercel = provider({ redeploy });
    const registry = new ToolRegistry();
    registry.register(new VercelRedeployTool(vercel));
    registry.register(new VercelCheckDeploymentTool(vercel, network()));
    let call = 0;
    const approval = vi.fn(async () => ({ approved: true }));
    const runtime = new AgentRuntime({
      registry,
      aiReasoner: new CallbackAIReasoner(() => {
        call += 1;
        return call === 1
          ? reasoning(AIReasoningDecision.TAKE_ACTION, { recommendedTool: 'vercel_redeploy', toolArguments: { deploymentIdOrUrl: 'dpl_123' } })
          : reasoning(AIReasoningDecision.VERIFY);
      }),
      verifier: new ToolVerifier({
        toolName: 'vercel_check_deployment',
        input: { deploymentIdOrUrl: 'dpl_123' },
        evaluateOutput: (output) => ({
          status: output && typeof output === 'object' && 'healthy' in output && output.healthy === true ? VerificationStatus.PASSED : VerificationStatus.FAILED,
          summary: 'Checked deployment.',
        }),
      }),
      approvalProvider: { requestApproval: approval },
    });

    const result = await runtime.investigate('Redeploy the broken Vercel deployment');

    expect(result.status).toBe(InvestigationStatus.COMPLETED);
    expect(approval).toHaveBeenCalledTimes(1);
    expect(redeploy).toHaveBeenCalledTimes(1);
    expect(result.events?.some((event) => event.type === InvestigationEventType.APPROVAL_REQUESTED)).toBe(true);
  });

  it('never reaches the Vercel provider when redeploy approval is rejected', async () => {
    const redeploy = vi.fn(async () => deployment({ id: 'should-not-exist' }));
    const registry = new ToolRegistry();
    registry.register(new VercelRedeployTool(provider({ redeploy })));
    const runtime = new AgentRuntime({
      registry,
      aiReasoner: new CallbackAIReasoner(() => reasoning(AIReasoningDecision.TAKE_ACTION, {
        recommendedTool: 'vercel_redeploy',
        toolArguments: { deploymentIdOrUrl: 'dpl_123' },
        risk: RiskLevel.READ_ONLY,
      })),
      verifier: new ToolVerifier({ toolName: 'vercel_redeploy', input: { deploymentIdOrUrl: 'dpl_123' } }),
      approvalProvider: { requestApproval: vi.fn(async () => ({ approved: false, reason: 'operator rejected redeploy' })) },
    });

    const result = await runtime.investigate('Redeploy this');

    expect(result.status).toBe(InvestigationStatus.REJECTED);
    expect(redeploy).not.toHaveBeenCalled();
  });

  it('forces consequential approval even when an injected policy returns ALLOWED', async () => {
    const redeploy = vi.fn(async () => deployment({ id: 'should-not-exist' }));
    const registry = new ToolRegistry();
    registry.register(new VercelRedeployTool(provider({ redeploy })));
    const approval = vi.fn(async () => ({ approved: false, reason: 'explicitly rejected' }));
    const runtime = new AgentRuntime({
      registry,
      aiReasoner: new CallbackAIReasoner(() => reasoning(AIReasoningDecision.TAKE_ACTION, {
        recommendedTool: 'vercel_redeploy',
        toolArguments: { deploymentIdOrUrl: 'dpl_123' },
      })),
      verifier: new ToolVerifier({ toolName: 'vercel_redeploy', input: { deploymentIdOrUrl: 'dpl_123' } }),
      permissionPolicy: { evaluate: () => PermissionDecision.ALLOWED },
      approvalProvider: { requestApproval: approval },
    });

    const result = await runtime.investigate('Redeploy this');

    expect(result.status).toBe(InvestigationStatus.REJECTED);
    expect(approval).toHaveBeenCalledTimes(1);
    expect(redeploy).not.toHaveBeenCalled();
  });

  it('marks rollback as consequential and reports only an accepted request', async () => {
    const tool = new VercelRollbackTool(provider());
    const result = await tool.execute({ projectId: 'prj_1', deploymentId: 'dpl_previous' }, context);

    expect(tool.riskLevel).toBe(RiskLevel.CONSEQUENTIAL);
    expect(result.success).toBe(true);
    expect(result.summary).toContain('accepted the rollback request');
    expect(result.summary).toContain('verified separately');
  });
});
