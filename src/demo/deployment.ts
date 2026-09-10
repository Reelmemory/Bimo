import { AgentRuntime } from '../agent/runtime.js';
import { BasicReasoner } from '../agent/reasoning.js';
import { CallbackPlanner } from '../agent/planner.js';
import { EvidenceRecoveryHandler } from '../agent/recovery.js';
import { ToolVerifier } from '../agent/verifier.js';
import { approvingProvider } from '../safety/approval.js';
import { InvestigationStatus, VerificationStatus, type ActionPlan } from '../types/investigation.js';
import { createMockDeploymentTools, type MockDeploymentScenario } from '../tools/mocks.js';
import { DeploymentDiagnosticsTool } from '../tools/deployment-diagnostics.js';
import { AnakinResearchTool } from '../tools/anakin-research.js';
import { createAnakinResearchClient } from '../integrations/anakin/client.js';
import type { ResearchProvider } from '../integrations/research.js';
import { CallbackRecoveryHandler } from '../agent/recovery.js';
import type { IdFactory } from '../agent/state.js';
import type { InvestigationEvent, InvestigationState } from '../types/investigation.js';
import type { ApprovalProvider } from '../safety/approval.js';

export interface RuntimeBoundaryOptions {
  approvalProvider?: ApprovalProvider;
  idFactory?: IdFactory;
  onEvent?: (event: InvestigationEvent, state: InvestigationState) => void;
}

const plan = (toolName: string, id: string, objective: string, input: ActionPlan['actions'][number]['input'] = null): ActionPlan => ({
  id: `plan-${id}`,
  objective,
  actions: [{
    id: `action-${id}`,
    toolName,
    input,
    purpose: objective,
    expectedResult: 'Structured evidence or a successful simulated operation',
    rationale: objective,
  }],
});

const remediationPlan = (attempt: number): ActionPlan => ({
  id: `plan-remediate-${attempt}`,
  objective: 'Repair the dependency and deploy the application',
  actions: [
    {
      id: `action-fix-dependency-${attempt}`,
      toolName: 'mock_fix_dependency',
      input: null,
      purpose: 'Repair the dependency problem identified in the evidence',
      expectedResult: 'Dependency state is corrected',
      rationale: 'Repair the dependency problem identified in the evidence.',
    },
    {
      id: `action-deploy-${attempt}`,
      toolName: 'mock_deploy',
      input: null,
      purpose: 'Deploy the repaired application',
      expectedResult: 'The simulated deployment is running',
      rationale: 'Deploy the repaired application to verify the fix.',
    },
  ],
});

export const createDeploymentDemoRuntime = (
  scenario: MockDeploymentScenario = {},
  boundary: RuntimeBoundaryOptions = {},
): AgentRuntime => {
  const { registry } = createMockDeploymentTools(scenario);

  return new AgentRuntime({
    registry,
    reasoner: new BasicReasoner(),
    planner: new CallbackPlanner((state) => state.status === InvestigationStatus.READING
      ? plan('mock_read_deployment_logs', 'read-logs', 'Inspect deployment failure logs')
      : remediationPlan(state.recoveryAttempts + 1)),
    verifier: new ToolVerifier({
      toolName: 'mock_verify_deployment',
      evaluateOutput: (output) => {
        const healthy = Boolean(output && typeof output === 'object' && 'healthy' in output && output.healthy);
        return {
          status: healthy ? VerificationStatus.PASSED : VerificationStatus.FAILED,
          summary: healthy ? 'The simulated deployment is healthy.' : 'The simulated deployment is still failing.',
          details: output ?? null,
        };
      },
    }),
    recovery: new EvidenceRecoveryHandler('mock_read_deployment_logs'),
    approvalProvider: boundary.approvalProvider ?? approvingProvider(),
    ...(boundary.idFactory ? { idFactory: boundary.idFactory } : {}),
    ...(boundary.onEvent ? { onEvent: boundary.onEvent } : {}),
    maxRecoveryAttempts: 2,
  });
};

export const runDeploymentDemo = async (scenario: MockDeploymentScenario = {}) =>
  createDeploymentDemoRuntime(scenario).investigate('My deployment is failing.');

export const createAnakinDeploymentDemoRuntime = (
  provider: ResearchProvider = createAnakinResearchClient(),
  scenario: MockDeploymentScenario = {},
): AgentRuntime => {
  const { registry } = createMockDeploymentTools(scenario);
  registry.register(new AnakinResearchTool(provider));
  registry.register(new DeploymentDiagnosticsTool(provider));

  return new AgentRuntime({
    registry,
    reasoner: new BasicReasoner(),
    planner: new CallbackPlanner((state) => state.status === InvestigationStatus.READING
      ? plan('deployment_diagnostics', 'deployment-diagnostics', 'Research the Vercel deployment failure', {
        errorMessage: state.userProblem,
        framework: 'Vercel',
        packageManager: 'npm',
        researchMode: 'search',
      })
      : remediationPlan(state.recoveryAttempts + 1)),
    verifier: new ToolVerifier({
      toolName: 'mock_verify_deployment',
      evaluateOutput: (output) => {
        const healthy = Boolean(output && typeof output === 'object' && 'healthy' in output && output.healthy);
        return {
          status: healthy ? VerificationStatus.PASSED : VerificationStatus.FAILED,
          summary: healthy ? 'The simulated deployment is healthy.' : 'The simulated deployment is still failing.',
          details: output ?? null,
        };
      },
    }),
    recovery: new CallbackRecoveryHandler((state) => plan(
      'deployment_diagnostics',
      `deployment-recovery-${state.recoveryAttempts}`,
      'Re-research the deployment after verification failed',
      { errorMessage: state.userProblem, framework: 'Vercel', packageManager: 'npm', researchMode: 'search' },
    )),
    approvalProvider: approvingProvider(),
    maxRecoveryAttempts: 2,
  });
};

export const runAnakinDeploymentDemo = async (
  provider?: ResearchProvider,
  scenario: MockDeploymentScenario = {},
) => createAnakinDeploymentDemoRuntime(provider ?? createAnakinResearchClient(), scenario)
  .investigate('My Vercel deployment is failing with a build error.');
