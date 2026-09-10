import { describe, expect, it, vi } from 'vitest';
import {
  AIReasoningDecision,
  CallbackAIReasoner,
  EvidenceSource,
  InvestigationStatus,
  approvingProvider,
  createVercelOperationsRuntime,
  createWeb3OperationsRuntime,
  type AIReasoningResult,
  type NetworkDiagnosticsProvider,
  type ResearchProvider,
  type VercelDeployment,
  type VercelProvider,
  type Web3DiagnosticsProvider,
} from '../src/index.js';

const txHash = `0x${'c'.repeat(64)}`;
const reasoning = (decision: AIReasoningDecision, overrides: Partial<AIReasoningResult> = {}): AIReasoningResult => ({
  decision,
  hypothesis: 'More operational evidence is needed.',
  confidence: 0.75,
  reasoningSummary: 'Select the best registered diagnostic tool.',
  informationNeeded: [],
  recommendedTool: null,
  toolArguments: null,
  recommendedAction: null,
  expectedResult: null,
  risk: null,
  approvalMayBeRequired: false,
  ...overrides,
});

const deployment: VercelDeployment = {
  id: 'dpl_broken', url: 'broken.vercel.app', status: 'ERROR', name: 'broken', projectId: 'prj_broken',
  project: { id: 'prj_broken', name: 'broken', framework: 'nextjs' }, git: { branch: 'main', commitSha: 'abc' }, target: 'production',
  createdAt: null, buildingAt: null, readyAt: null, errorCode: 'BUILD_FAILED', errorMessage: 'Module not found', errorStep: 'build', regions: [], metadata: {},
};

const vercelProvider = (): VercelProvider => ({
  getDeployment: vi.fn(async () => deployment),
  getDeploymentLogs: vi.fn(async () => [{
    id: 'log-error', timestamp: new Date().toISOString(), type: 'stderr', level: 'error', text: 'Module not found: package-x', step: 'build',
  }]),
  redeploy: vi.fn(async () => deployment),
  rollback: vi.fn(async (input) => ({ accepted: true as const, projectId: input.projectId, deploymentId: input.deploymentId })),
});

const networkProvider = (overrides: Partial<NetworkDiagnosticsProvider> = {}): NetworkDiagnosticsProvider => ({
  httpHealthCheck: vi.fn(async ({ url }) => ({ ok: false, url, finalUrl: url, statusCode: 503, responseTimeMs: 10, redirects: [], headers: {} })),
  dnsLookup: vi.fn(async ({ hostname, recordType }) => ({ hostname, recordType, records: ['203.0.113.1'] })),
  tlsCheck: vi.fn(async ({ hostname, port = 443 }) => ({
    hostname, port, authorized: true, protocol: 'TLSv1.3', cipher: 'cipher', subject: {}, issuer: {}, validFrom: null, validTo: null,
    daysRemaining: null, fingerprint256: null, serialNumber: null, subjectAltName: null,
  })),
  ...overrides,
});

const researchProvider = (): ResearchProvider => ({
  search: vi.fn(async (query) => ({ query, results: [{ url: 'https://nextjs.org/docs/messages/module-not-found', title: 'Module not found', snippet: 'Check package installation and import paths.' }] })),
  research: vi.fn(async (query) => ({ query, summary: 'Research complete', sources: [] })),
});

describe('Phase 4 AI tool composition', () => {
  it('selects Vercel evidence first and Anakin research after the deployment error is observed', async () => {
    const vercel = vercelProvider();
    const research = researchProvider();
    let call = 0;
    const runtime = createVercelOperationsRuntime({
      deploymentIdOrUrl: 'dpl_broken',
      aiReasoner: new CallbackAIReasoner((input) => {
        call += 1;
        if (call === 1) return reasoning(AIReasoningDecision.NEED_INFORMATION, {
          recommendedTool: 'vercel_get_deployment', toolArguments: { deploymentIdOrUrl: 'dpl_broken' },
        });
        if (call === 2) {
          expect(input.evidence.some((item) => item.source === EvidenceSource.VERCEL)).toBe(true);
          return reasoning(AIReasoningDecision.NEED_INFORMATION, {
            recommendedTool: 'vercel_get_deployment_logs', toolArguments: { deploymentIdOrUrl: 'dpl_broken' },
          });
        }
        if (call === 3) {
          expect(input.evidence.some((item) => item.type === 'LOG')).toBe(true);
          return reasoning(AIReasoningDecision.NEED_INFORMATION, {
            recommendedTool: 'anakin_research', toolArguments: { query: 'Next.js Module not found package installation' },
          });
        }
        return reasoning(AIReasoningDecision.COMPLETE, { reasoningSummary: 'The deployment failed because package-x was not installed.' });
      }),
      vercelProvider: vercel,
      researchProvider: research,
      networkProvider: networkProvider(),
    });

    const result = await runtime.investigate('My deployment is broken');

    expect(result.status).toBe(InvestigationStatus.COMPLETED);
    expect(vercel.getDeployment).toHaveBeenCalled();
    expect(vercel.getDeploymentLogs).toHaveBeenCalled();
    expect(research.search).toHaveBeenCalled();
    expect(result.evidence.some((item) => item.source === EvidenceSource.ANAKIN)).toBe(true);
  });

  it('selects Web3 transaction diagnostics for a transaction problem', async () => {
    const getTransaction = vi.fn(async () => ({
      hash: txHash, from: `0x${'1'.repeat(40)}`, to: `0x${'2'.repeat(40)}`, valueWei: '0', gasLimit: '21000',
      gasPriceWei: '1', maxFeePerGasWei: null, maxPriorityFeePerGasWei: null, nonce: '1', input: '0x', blockNumber: '100',
    }));
    const web3: Web3DiagnosticsProvider = {
      getChainInfo: vi.fn(async () => ({ chainId: '1', name: 'Ethereum Mainnet', latestBlockNumber: '101', gasPriceWei: '1' })),
      getTransaction,
      getTransactionReceipt: vi.fn(async () => ({ transactionHash: txHash, status: 'FAILED' as const, blockNumber: '100', gasUsed: '21000', effectiveGasPriceWei: '1', contractAddress: null })),
      getBlock: vi.fn(async () => ({ number: '100', hash: null, timestamp: null, baseFeePerGasWei: null })),
      getRevertInfo: vi.fn(async () => ({ message: 'execution reverted', data: null })),
    };
    let call = 0;
    const runtime = createWeb3OperationsRuntime({
      transactionHash: txHash,
      aiReasoner: new CallbackAIReasoner((input) => {
        call += 1;
        if (call === 1) return reasoning(AIReasoningDecision.NEED_INFORMATION, {
          recommendedTool: 'web3_transaction_diagnostics', toolArguments: { transactionHash: txHash },
        });
        expect(input.evidence.some((item) => item.source === EvidenceSource.WEB3)).toBe(true);
        return reasoning(AIReasoningDecision.COMPLETE, { reasoningSummary: 'The transaction reverted in contract execution.' });
      }),
      web3Provider: web3,
      researchProvider: researchProvider(),
    });

    const result = await runtime.investigate('My transaction failed');

    expect(result.status).toBe(InvestigationStatus.COMPLETED);
    expect(getTransaction).toHaveBeenCalledWith(txHash);
    expect(result.evidence.some((item) => item.source === EvidenceSource.WEB3)).toBe(true);
  });

  it('independently verifies the deployment created by a redeploy action', async () => {
    const checkedDeploymentIds: string[] = [];
    const vercel: VercelProvider = {
      getDeployment: vi.fn(async (input) => {
        checkedDeploymentIds.push(input.deploymentIdOrUrl);
        return input.deploymentIdOrUrl === 'dpl_new'
          ? { ...deployment, id: 'dpl_new', url: 'new.vercel.app', status: 'READY' }
          : deployment;
      }),
      getDeploymentLogs: vi.fn(async () => []),
      redeploy: vi.fn(async () => ({ ...deployment, id: 'dpl_new', url: 'new.vercel.app', status: 'BUILDING' })),
      rollback: vi.fn(async (input) => ({ accepted: true as const, projectId: input.projectId, deploymentId: input.deploymentId })),
    };
    const network = networkProvider({
      httpHealthCheck: vi.fn(async ({ url }) => ({
        ok: true, url, finalUrl: url, statusCode: 200, responseTimeMs: 15, redirects: [], headers: {},
      })),
    });
    let call = 0;
    const runtime = createVercelOperationsRuntime({
      deploymentIdOrUrl: 'dpl_broken',
      aiReasoner: new CallbackAIReasoner(() => {
        call += 1;
        return call === 1
          ? reasoning(AIReasoningDecision.TAKE_ACTION, {
              recommendedTool: 'vercel_redeploy',
              toolArguments: { deploymentIdOrUrl: 'dpl_broken' },
            })
          : reasoning(AIReasoningDecision.VERIFY);
      }),
      vercelProvider: vercel,
      researchProvider: researchProvider(),
      networkProvider: network,
      approvalProvider: approvingProvider(),
    });

    const result = await runtime.investigate('Redeploy and verify the broken deployment');

    expect(result.status).toBe(InvestigationStatus.COMPLETED);
    expect(checkedDeploymentIds).toEqual(['dpl_new']);
    expect(result.verification?.status).toBe('PASSED');
  });

  it('independently verifies rollback routing instead of trusting provider acceptance', async () => {
    const checkedDeploymentIds: string[] = [];
    const getDeploymentAliases = vi.fn(async () => [{
      uid: 'alias_1', alias: 'app.example.com', redirect: null, createdAt: null,
    }]);
    const vercel: VercelProvider = {
      getDeployment: vi.fn(async (input) => {
        checkedDeploymentIds.push(input.deploymentIdOrUrl);
        return { ...deployment, id: input.deploymentIdOrUrl, status: 'READY' };
      }),
      getDeploymentLogs: vi.fn(async () => []),
      redeploy: vi.fn(async () => deployment),
      rollback: vi.fn(async (input) => ({ accepted: true as const, projectId: input.projectId, deploymentId: input.deploymentId })),
      getDeploymentAliases,
    };
    const network = networkProvider({
      httpHealthCheck: vi.fn(async ({ url }) => ({
        ok: true, url, finalUrl: url, statusCode: 200, responseTimeMs: 15, redirects: [], headers: {},
      })),
    });
    let call = 0;
    const runtime = createVercelOperationsRuntime({
      deploymentIdOrUrl: 'dpl_current',
      aiReasoner: new CallbackAIReasoner(() => {
        call += 1;
        return call === 1
          ? reasoning(AIReasoningDecision.TAKE_ACTION, {
              recommendedTool: 'vercel_rollback',
              toolArguments: { projectId: 'prj_broken', deploymentId: 'dpl_previous' },
            })
          : reasoning(AIReasoningDecision.VERIFY);
      }),
      vercelProvider: vercel,
      researchProvider: researchProvider(),
      networkProvider: network,
      approvalProvider: approvingProvider(),
    });

    const result = await runtime.investigate('Roll back the broken deployment and verify production.');

    expect(result.status).toBe(InvestigationStatus.COMPLETED);
    expect(checkedDeploymentIds).toEqual(['dpl_previous']);
    expect(getDeploymentAliases).toHaveBeenCalledWith({ deploymentIdOrUrl: 'dpl_previous' });
    expect(result.verification?.status).toBe('PASSED');
  });
});
