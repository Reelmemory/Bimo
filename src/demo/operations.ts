import type { AIReasoner } from '../agent/ai-reasoner.js';
import { createOpenAICompatibleReasoner } from '../agent/structured-ai-reasoner.js';
import { AgentRuntime } from '../agent/runtime.js';
import { ToolVerifier } from '../agent/verifier.js';
import { createAnakinResearchClient } from '../integrations/anakin/client.js';
import type { ResearchProvider } from '../integrations/research.js';
import { createNodeNetworkProvider } from '../integrations/network/node-network.js';
import type { NetworkDiagnosticsProvider } from '../integrations/network/types.js';
import { createVercelClient } from '../integrations/vercel/client.js';
import type { VercelProvider } from '../integrations/vercel/types.js';
import { createJsonRpcWeb3Provider } from '../integrations/web3/json-rpc.js';
import type { Web3DiagnosticsProvider } from '../integrations/web3/types.js';
import type { ApprovalProvider } from '../safety/approval.js';
import { ToolRegistry } from '../tools/registry.js';
import { AnakinResearchTool } from '../tools/anakin-research.js';
import { createNetworkTools } from '../tools/network.js';
import { createVercelTools } from '../tools/vercel.js';
import { Web3TransactionDiagnosticsTool } from '../tools/web3-transaction-diagnostics.js';
import { VerificationStatus, type JsonValue } from '../types/investigation.js';

const objectValue = (value: JsonValue | undefined): { [key: string]: JsonValue } | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;

interface VercelVerificationTarget {
  deploymentIdOrUrl: string;
  expectedDeploymentId?: string;
  verifyProductionRouting?: boolean;
}

const latestVercelVerificationTarget = (
  state: Parameters<NonNullable<ConstructorParameters<typeof ToolVerifier>[0]['inputFactory']>>[0],
  fallback: string,
): VercelVerificationTarget => {
  for (const action of [...(state.actionHistory ?? [])].reverse()) {
    if (action.toolName !== 'vercel_redeploy' && action.toolName !== 'vercel_rollback') continue;
    const output = objectValue(action.output);
    const id = typeof output?.id === 'string' ? output.id
      : typeof output?.deploymentId === 'string' ? output.deploymentId : undefined;
    const url = typeof output?.url === 'string' ? output.url : undefined;
    if (id || url) {
      return action.toolName === 'vercel_rollback' && id
        ? { deploymentIdOrUrl: id, expectedDeploymentId: id, verifyProductionRouting: true }
        : { deploymentIdOrUrl: id ?? url! };
    }
  }
  return { deploymentIdOrUrl: fallback };
};

export interface VercelOperationsRuntimeOptions {
  deploymentIdOrUrl: string;
  aiReasoner: AIReasoner;
  vercelProvider: VercelProvider;
  researchProvider: ResearchProvider;
  networkProvider: NetworkDiagnosticsProvider;
  approvalProvider?: ApprovalProvider;
}

export const createVercelOperationsRuntime = (options: VercelOperationsRuntimeOptions): AgentRuntime => {
  const registry = new ToolRegistry();
  registry.registerMany([
    ...createVercelTools(options.vercelProvider, options.networkProvider),
    ...createNetworkTools(options.networkProvider),
    new AnakinResearchTool(options.researchProvider),
  ]);
  return new AgentRuntime({
    registry,
    aiReasoner: options.aiReasoner,
    verifier: new ToolVerifier({
      toolName: 'vercel_check_deployment',
      input: { deploymentIdOrUrl: options.deploymentIdOrUrl, performHttpCheck: true },
      inputFactory: (state) => ({
        ...latestVercelVerificationTarget(state, options.deploymentIdOrUrl),
        performHttpCheck: true,
      }),
      evaluateOutput: (output) => ({
        status: objectValue(output)?.healthy === true ? VerificationStatus.PASSED : VerificationStatus.FAILED,
        summary: objectValue(output)?.healthy === true
          ? 'Vercel deployment and HTTP health verification passed.'
          : 'Vercel deployment or HTTP health verification failed.',
        details: output ?? null,
      }),
    }),
    ...(options.approvalProvider ? { approvalProvider: options.approvalProvider } : {}),
    maxReasoningIterations: 14,
    maxToolCalls: 20,
    maxRecoveryAttempts: 3,
  });
};

export const runVercelOperationsDemo = (
  deploymentIdOrUrl: string,
  approvalProvider?: ApprovalProvider,
) => {
  const networkProvider = createNodeNetworkProvider();
  const runtime = createVercelOperationsRuntime({
    deploymentIdOrUrl,
    aiReasoner: createOpenAICompatibleReasoner(),
    vercelProvider: createVercelClient(),
    researchProvider: createAnakinResearchClient(),
    networkProvider,
    ...(approvalProvider ? { approvalProvider } : {}),
  });
  return runtime.investigate(`My Vercel deployment ${deploymentIdOrUrl} is broken. Investigate it using registered tools, research unfamiliar errors when useful, and do not redeploy without approval.`);
};

export interface Web3OperationsRuntimeOptions {
  transactionHash: string;
  aiReasoner: AIReasoner;
  web3Provider: Web3DiagnosticsProvider;
  researchProvider: ResearchProvider;
}

export const createWeb3OperationsRuntime = (options: Web3OperationsRuntimeOptions): AgentRuntime => {
  const registry = new ToolRegistry();
  registry.registerMany([
    new Web3TransactionDiagnosticsTool(options.web3Provider),
    new AnakinResearchTool(options.researchProvider),
  ]);
  return new AgentRuntime({
    registry,
    aiReasoner: options.aiReasoner,
    verifier: new ToolVerifier({
      toolName: 'web3_transaction_diagnostics',
      input: { transactionHash: options.transactionHash },
      evaluateOutput: (output, actionResult) => ({
        status: actionResult.success ? VerificationStatus.PASSED : VerificationStatus.FAILED,
        summary: actionResult.success ? 'Transaction diagnostics were confirmed by the RPC provider.' : 'Transaction diagnostics could not be confirmed.',
        details: output ?? null,
      }),
    }),
    maxReasoningIterations: 10,
    maxToolCalls: 12,
    maxRecoveryAttempts: 2,
  });
};

export const runWeb3OperationsDemo = (transactionHash: string) =>
  createWeb3OperationsRuntime({
    transactionHash,
    aiReasoner: createOpenAICompatibleReasoner(),
    web3Provider: createJsonRpcWeb3Provider(),
    researchProvider: createAnakinResearchClient(),
  }).investigate(`My transaction ${transactionHash} failed. Diagnose it without signing or broadcasting any transaction, and research unfamiliar errors only when needed.`);

export interface NetworkOperationsRuntimeOptions {
  url: string;
  aiReasoner: AIReasoner;
  networkProvider: NetworkDiagnosticsProvider;
}

export const createNetworkOperationsRuntime = (options: NetworkOperationsRuntimeOptions): AgentRuntime => {
  const registry = new ToolRegistry();
  registry.registerMany(createNetworkTools(options.networkProvider));
  return new AgentRuntime({
    registry,
    aiReasoner: options.aiReasoner,
    verifier: new ToolVerifier({
      toolName: 'http_health_check',
      input: { url: options.url },
      evaluateOutput: (output) => ({
        status: objectValue(output)?.ok === true ? VerificationStatus.PASSED : VerificationStatus.FAILED,
        summary: objectValue(output)?.ok === true ? 'The API is reachable over HTTP.' : 'The API remains unreachable or unhealthy.',
        details: output ?? null,
      }),
    }),
    maxReasoningIterations: 10,
    maxToolCalls: 12,
    maxRecoveryAttempts: 2,
  });
};

export const runNetworkOperationsDemo = (url: string) =>
  createNetworkOperationsRuntime({
    url,
    aiReasoner: createOpenAICompatibleReasoner(),
    networkProvider: createNodeNetworkProvider(),
  }).investigate(`My API at ${url} is unreachable. Use HTTP, DNS, and TLS diagnostics as appropriate to identify the likely failure point.`);
