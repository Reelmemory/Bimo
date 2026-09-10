import { describe, expect, it, vi } from 'vitest';
import {
  AgentRuntime,
  BasicReasoner,
  CallbackApprovalProvider,
  CallbackPlanner,
  CallbackRecoveryHandler,
  EvidenceRecoveryHandler,
  InvestigationStatus,
  RiskLevel,
  ToolRegistry,
  ToolVerifier,
  VerificationStatus,
  approvingProvider,
  createMockDeploymentTools,
  type ActionPlan,
  type JsonValue,
  type Tool,
} from '../src/index.js';

const actionPlan = (toolName: string, id = toolName): ActionPlan => ({
  id: `plan-${id}`,
  objective: id,
  actions: [{ id: `action-${id}`, toolName, input: null }],
});

const deploymentRemediationPlan = (attempt: number): ActionPlan => ({
  id: `plan-remediation-${attempt}`,
  objective: 'Fix and deploy',
  actions: [
    { id: `action-fix-${attempt}`, toolName: 'mock_fix_dependency', input: null },
    { id: `action-deploy-${attempt}`, toolName: 'mock_deploy', input: null },
  ],
});

const makeRuntime = (options: ConstructorParameters<typeof AgentRuntime>[0]): AgentRuntime =>
  new AgentRuntime(options);

describe('AgentRuntime safety and lifecycle', () => {
  it('executes a read-only action without approval', async () => {
    const execute = vi.fn(async () => ({ success: true, output: { healthy: true } as JsonValue }));
    const tool: Tool<null, JsonValue> = {
      name: 'read',
      description: 'read-only test tool',
      riskLevel: RiskLevel.READ_ONLY,
      inputDefinition: { type: 'null' },
      execute,
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const approval = vi.fn(async () => ({ approved: true }));
    const runtime = makeRuntime({
      registry,
      reasoner: { analyze: () => ({ hypothesis: { id: 'h', statement: 'test' } }) },
      planner: new CallbackPlanner((state) => state.status === InvestigationStatus.READING ? actionPlan('read') : actionPlan('read', 'verify-read')),
      verifier: new ToolVerifier({ toolName: 'read' }),
      approvalProvider: new CallbackApprovalProvider(approval),
    });

    const result = await runtime.investigate('check service');

    expect(result.status).toBe(InvestigationStatus.COMPLETED);
    expect(execute).toHaveBeenCalled();
    expect(approval).not.toHaveBeenCalled();
  });

  it('requests approval for a consequential action', async () => {
    const execute = vi.fn(async () => ({ success: true, output: { deployed: true } as JsonValue }));
    const deploy: Tool<null, JsonValue> = {
      name: 'deploy',
      description: 'consequential test tool',
      riskLevel: RiskLevel.CONSEQUENTIAL,
      inputDefinition: { type: 'null' },
      execute,
    };
    const verify: Tool<null, JsonValue> = {
      name: 'verify',
      description: 'verification tool',
      riskLevel: RiskLevel.READ_ONLY,
      inputDefinition: { type: 'null' },
      execute: async () => ({ success: true, output: { healthy: true } }),
    };
    const registry = new ToolRegistry();
    registry.registerMany([deploy, verify]);
    const approval = vi.fn(async () => ({ approved: true }));
    const runtime = makeRuntime({
      registry,
      reasoner: { analyze: () => ({ hypothesis: { id: 'h', statement: 'deploy' } }) },
      planner: new CallbackPlanner((state) => state.status === InvestigationStatus.READING ? null : actionPlan('deploy')),
      verifier: new ToolVerifier({ toolName: 'verify' }),
      approvalProvider: new CallbackApprovalProvider(approval),
    });

    await runtime.investigate('deploy application');

    expect(approval).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('prevents execution when consequential approval is rejected', async () => {
    const execute = vi.fn(async () => ({ success: true, output: { deployed: true } as JsonValue }));
    const deploy: Tool<null, JsonValue> = {
      name: 'deploy',
      description: 'consequential test tool',
      riskLevel: RiskLevel.CONSEQUENTIAL,
      inputDefinition: { type: 'null' },
      execute,
    };
    const registry = new ToolRegistry();
    registry.register(deploy);
    const runtime = makeRuntime({
      registry,
      reasoner: { analyze: () => ({ hypothesis: { id: 'h', statement: 'deploy' } }) },
      planner: new CallbackPlanner(() => actionPlan('deploy')),
      verifier: new ToolVerifier({ toolName: 'deploy' }),
      approvalProvider: new CallbackApprovalProvider(async () => ({ approved: false, reason: 'operator declined' })),
    });

    const result = await runtime.investigate('deploy application');

    expect(result.status).toBe(InvestigationStatus.REJECTED);
    expect(result.finalResult?.outcome).toBe('REJECTED');
    expect(execute).not.toHaveBeenCalled();
  });

  it('completes after successful verification', async () => {
    const { registry, state: mockState } = createMockDeploymentTools();
    const runtime = makeRuntime({
      registry,
      reasoner: new BasicReasoner(),
      planner: new CallbackPlanner((state) => state.status === InvestigationStatus.READING
        ? actionPlan('mock_read_deployment_logs', 'read-logs')
        : deploymentRemediationPlan(state.recoveryAttempts + 1)),
      verifier: new ToolVerifier({
        toolName: 'mock_verify_deployment',
        evaluateOutput: (output) => ({
          status: (output && typeof output === 'object' && 'healthy' in output && output.healthy === true)
            ? VerificationStatus.PASSED : VerificationStatus.FAILED,
          summary: output && typeof output === 'object' && 'healthy' in output && output.healthy === true
            ? 'Deployment is healthy.' : 'Deployment is still unhealthy.',
        }),
      }),
      recovery: new CallbackRecoveryHandler(() => null),
      approvalProvider: approvingProvider(),
    });

    const result = await runtime.investigate('My deployment is failing.');

    expect(result.status).toBe(InvestigationStatus.COMPLETED);
    expect(result.finalResult?.outcome).toBe('SUCCESS');
    expect(result.currentHypothesis?.statement).toMatch(/dependency|build/i);
    expect(mockState.dependencyFixed).toBe(true);
    expect(mockState.deployed).toBe(true);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('invokes recovery after a failed verification', async () => {
    const { registry } = createMockDeploymentTools();
    const recovery = vi.fn((state: { recoveryAttempts: number }) =>
      actionPlan('mock_read_deployment_logs', `recovery-${state.recoveryAttempts}`));
    const runtime = makeRuntime({
      registry,
      reasoner: new BasicReasoner(),
      planner: new CallbackPlanner((state) => state.status === InvestigationStatus.READING
        ? actionPlan('mock_read_deployment_logs', 'read-logs')
        : deploymentRemediationPlan(state.recoveryAttempts + 1)),
      verifier: new ToolVerifier({
        toolName: 'mock_verify_deployment',
        evaluateOutput: () => ({ status: VerificationStatus.FAILED, summary: 'Forced failure.' }),
      }),
      recovery: new CallbackRecoveryHandler(recovery),
      approvalProvider: approvingProvider(),
      maxRecoveryAttempts: 1,
    });

    const result = await runtime.investigate('My deployment is failing.');

    expect(recovery).toHaveBeenCalledTimes(1);
    expect(result.recoveryAttempts).toBe(1);
    expect(result.observations.some((item) => item.toLowerCase().includes('verification failed'))).toBe(true);
  });

  it('triggers recovery after failed verification and eventually succeeds', async () => {
    const { registry, state: mockState } = createMockDeploymentTools({ failFirstFix: true });
    const runtime = makeRuntime({
      registry,
      reasoner: new BasicReasoner(),
      planner: new CallbackPlanner((state) => state.status === InvestigationStatus.READING
        ? actionPlan('mock_read_deployment_logs', 'read-logs')
        : deploymentRemediationPlan(state.recoveryAttempts + 1)),
      verifier: new ToolVerifier({
        toolName: 'mock_verify_deployment',
        evaluateOutput: (output) => ({
          status: output && typeof output === 'object' && 'healthy' in output && output.healthy === true
            ? VerificationStatus.PASSED : VerificationStatus.FAILED,
          summary: output && typeof output === 'object' && 'healthy' in output && output.healthy === true
            ? 'Deployment is healthy.' : 'Deployment remains unhealthy.',
        }),
      }),
      recovery: new EvidenceRecoveryHandler('mock_read_deployment_logs'),
      approvalProvider: approvingProvider(),
      maxRecoveryAttempts: 2,
    });

    const result = await runtime.investigate('My deployment is failing.');

    expect(result.status).toBe(InvestigationStatus.COMPLETED);
    expect(result.finalResult?.outcome).toBe('SUCCESS');
    expect(result.recoveryAttempts).toBe(1);
    expect(mockState.fixAttempts).toBe(2);
  });

  it('stops after the maximum recovery attempts', async () => {
    const { registry } = createMockDeploymentTools();
    const runtime = makeRuntime({
      registry,
      reasoner: new BasicReasoner(),
      planner: new CallbackPlanner((state) => state.status === InvestigationStatus.READING
        ? actionPlan('mock_read_deployment_logs', 'read-logs')
        : actionPlan('mock_fix_dependency', `fix-${state.recoveryAttempts + 1}`)),
      verifier: new ToolVerifier({
        toolName: 'mock_verify_deployment',
        evaluateOutput: () => ({ status: VerificationStatus.FAILED, summary: 'Forced verification failure.' }),
      }),
      recovery: new CallbackRecoveryHandler((state) => actionPlan('mock_read_deployment_logs', `recovery-read-${state.recoveryAttempts}`)),
      maxRecoveryAttempts: 2,
    });

    const result = await runtime.investigate('My deployment is failing.');

    expect(result.status).toBe(InvestigationStatus.FAILED);
    expect(result.finalResult?.outcome).toBe('MAX_RECOVERY_ATTEMPTS');
    expect(result.recoveryAttempts).toBe(2);
  });
});
