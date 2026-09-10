import { describe, expect, it, vi } from 'vitest';
import {
  JsonRpcWeb3Provider,
  Web3ConfigurationError,
  Web3ProviderError,
  Web3TransactionDiagnosticsTool,
  createJsonRpcWeb3Provider,
  type Web3DiagnosticsProvider,
  type Web3Transaction,
  type Web3TransactionReceipt,
} from '../src/index.js';

const transactionHash = `0x${'a'.repeat(64)}`;
const transaction: Web3Transaction = {
  hash: transactionHash,
  from: `0x${'1'.repeat(40)}`,
  to: `0x${'2'.repeat(40)}`,
  valueWei: '1000000000000000000',
  gasLimit: '21000',
  gasPriceWei: '1000000000',
  maxFeePerGasWei: null,
  maxPriorityFeePerGasWei: null,
  nonce: '1',
  input: '0x',
  blockNumber: '100',
};
const receipt = (status: 'SUCCESS' | 'FAILED' = 'SUCCESS'): Web3TransactionReceipt => ({
  transactionHash,
  status,
  blockNumber: '100',
  gasUsed: status === 'SUCCESS' ? '21000' : '20000',
  effectiveGasPriceWei: '1000000000',
  contractAddress: null,
});
const context = {
  investigationId: 'investigation-web3',
  userProblem: 'Transaction failed',
  evidence: [],
  recoveryAttempts: 0,
};
const provider = (overrides: Partial<Web3DiagnosticsProvider> = {}): Web3DiagnosticsProvider => ({
  getChainInfo: vi.fn(async () => ({ chainId: '1', name: 'Ethereum Mainnet', latestBlockNumber: '101', gasPriceWei: '1000000000' })),
  getTransaction: vi.fn(async () => transaction),
  getTransactionReceipt: vi.fn(async () => receipt()),
  getBlock: vi.fn(async () => ({ number: '100', hash: `0x${'b'.repeat(64)}`, timestamp: '2026-01-01T00:00:00.000Z', baseFeePerGasWei: '900000000' })),
  getRevertInfo: vi.fn(async () => null),
  ...overrides,
});

describe('Web3 transaction diagnostics', () => {
  it('returns a successful transaction with chain, gas, receipt, and block evidence', async () => {
    const result = await new Web3TransactionDiagnosticsTool(provider()).execute({ transactionHash }, context);

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      status: 'SUCCESS',
      chain: { chainId: '1' },
      transaction: { valueWei: '1000000000000000000', gasLimit: '21000' },
      receipt: { gasUsed: '21000' },
      block: { number: '100' },
    });
    expect(result.sources?.[0]?.url).toContain('etherscan.io/tx/');
  });

  it('reports a failed transaction without claiming a precise cause', async () => {
    const result = await new Web3TransactionDiagnosticsTool(provider({
      getTransactionReceipt: vi.fn(async () => receipt('FAILED')),
    })).execute({ transactionHash }, context);

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ status: 'FAILED', likelyFailureCategory: 'EXECUTION_FAILED_UNSPECIFIED', confidence: 0.45 });
  });

  it('classifies provider-confirmed revert information with bounded confidence', async () => {
    const result = await new Web3TransactionDiagnosticsTool(provider({
      getTransactionReceipt: vi.fn(async () => receipt('FAILED')),
      getRevertInfo: vi.fn(async () => ({ message: 'execution reverted: caller is not owner', data: null })),
    })).execute({ transactionHash }, context);

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ status: 'FAILED', likelyFailureCategory: 'CONTRACT_REVERT', confidence: 0.72 });
  });

  it('rejects malformed hashes before querying the RPC provider', async () => {
    const web3 = provider();
    const result = await new Web3TransactionDiagnosticsTool(web3).execute({ transactionHash: '0x1234' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('64 hexadecimal');
    expect(web3.getChainInfo).not.toHaveBeenCalled();
  });

  it('converts RPC failures into structured tool failures', async () => {
    const result = await new Web3TransactionDiagnosticsTool(provider({
      getChainInfo: vi.fn(async () => { throw new Web3ProviderError('RATE_LIMIT', 'Web3 RPC rate limit reached.'); }),
    })).execute({ transactionHash }, context);

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ code: 'RATE_LIMIT' });
  });

  it('normalizes JSON-RPC responses without exposing the RPC URL', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      const result = request.method === 'eth_getTransactionByHash'
        ? {
            hash: transactionHash, from: transaction.from, to: transaction.to, value: '0xde0b6b3a7640000', gas: '0x5208',
            gasPrice: '0x3b9aca00', nonce: '0x1', input: '0x', blockNumber: '0x64',
          }
        : null;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const rpc = new JsonRpcWeb3Provider({ rpcUrl: 'https://rpc.example.test/private-key', fetcher });

    const result = await rpc.getTransaction(transactionHash);

    expect(result).toMatchObject({ valueWei: '1000000000000000000', gasLimit: '21000', blockNumber: '100' });
    expect(JSON.stringify(result)).not.toContain('rpc.example.test');
  });

  it('requires WEB3_RPC_URL when no endpoint is injected', () => {
    const previous = process.env.WEB3_RPC_URL;
    delete process.env.WEB3_RPC_URL;
    try {
      expect(() => createJsonRpcWeb3Provider()).toThrow(Web3ConfigurationError);
    } finally {
      if (previous === undefined) delete process.env.WEB3_RPC_URL;
      else process.env.WEB3_RPC_URL = previous;
    }
  });

  it('enforces an RPC timeout even when the fetch implementation ignores abort signals', async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const rpc = new JsonRpcWeb3Provider({ rpcUrl: 'https://rpc.example.test', timeoutMs: 100, fetcher });

    await expect(rpc.getTransaction(transactionHash)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
