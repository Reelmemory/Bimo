import { AgentRuntime } from '../agent/runtime.js';
import type { AIReasoner } from '../agent/ai-reasoner.js';
import { createOpenAICompatibleReasoner } from '../agent/structured-ai-reasoner.js';
import { ToolVerifier } from '../agent/verifier.js';
import { approvingProvider } from '../safety/approval.js';
import { VerificationStatus } from '../types/investigation.js';
import { createMockDeploymentTools, type MockDeploymentScenario } from '../tools/mocks.js';
import { AnakinResearchTool } from '../tools/anakin-research.js';
import { createAnakinResearchClient } from '../integrations/anakin/client.js';
import type { ResearchProvider } from '../integrations/research.js';

const verifyDeployment = new ToolVerifier({
  toolName: 'mock_verify_deployment',
  evaluateOutput: (output) => {
    const healthy = Boolean(output && typeof output === 'object' && 'healthy' in output && output.healthy);
    return {
      status: healthy ? VerificationStatus.PASSED : VerificationStatus.FAILED,
      summary: healthy ? 'The simulated deployment is healthy.' : 'The simulated deployment is still failing.',
      details: output ?? null,
    };
  },
});

export const createAIDeploymentDemoRuntime = (
  aiReasoner: AIReasoner,
  researchProvider: ResearchProvider,
  scenario: MockDeploymentScenario = {},
): AgentRuntime => {
  const { registry } = createMockDeploymentTools(scenario);
  registry.register(new AnakinResearchTool(researchProvider));
  return new AgentRuntime({
    registry,
    aiReasoner,
    verifier: verifyDeployment,
    approvalProvider: approvingProvider(),
    maxReasoningIterations: 10,
    maxToolCalls: 12,
    maxRecoveryAttempts: 3,
  });
};

export const runAIDeploymentDemo = async (scenario: MockDeploymentScenario = {}) =>
  createAIDeploymentDemoRuntime(
    createOpenAICompatibleReasoner(),
    createAnakinResearchClient(),
    scenario,
  ).investigate('My Vercel deployment is failing with a Next.js build error.');
