import { EvidenceSource, EvidenceType, type Evidence, type JsonValue, type SourceReference } from '../types/investigation.js';
import type {
  Web3DiagnosticsProvider,
  Web3RevertInfo,
  Web3Transaction,
  Web3TransactionReceipt,
} from '../integrations/web3/types.js';
import { Web3ProviderError } from '../integrations/web3/json-rpc.js';
import { RiskLevel, type Tool, type ToolExecutionContext } from './types.js';

export interface Web3TransactionDiagnosticsInput {
  transactionHash: string;
  chain?: string;
}

interface Web3TransactionDiagnosticsOutput {
  [key: string]: JsonValue;
  transactionHash: string;
  chain: JsonValue;
  status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'NOT_FOUND' | 'UNKNOWN';
  transaction: JsonValue;
  receipt: JsonValue;
  block: JsonValue;
  revert: JsonValue;
  likelyFailureCategory: string | null;
  confidence: number;
}

const explorerUrl = (chainId: string, transactionHash: string): string | undefined => {
  const base = ({
    '1': 'https://etherscan.io',
    '10': 'https://optimistic.etherscan.io',
    '56': 'https://bscscan.com',
    '137': 'https://polygonscan.com',
    '8453': 'https://basescan.org',
    '42161': 'https://arbiscan.io',
    '43114': 'https://snowtrace.io',
    '11155111': 'https://sepolia.etherscan.io',
  } as Record<string, string>)[chainId];
  return base ? `${base}/tx/${transactionHash}` : undefined;
};

const decodeRevertData = (data: string | null): string | null => {
  if (!data || !/^0x[0-9a-f]+$/i.test(data)) return null;
  try {
    if (data.startsWith('0x08c379a0') && data.length >= 138) {
      const length = Number(BigInt(`0x${data.slice(74, 138)}`));
      const encoded = data.slice(138, 138 + length * 2);
      return Buffer.from(encoded, 'hex').toString('utf8');
    }
    if (data.startsWith('0x4e487b71') && data.length >= 74) {
      return `Solidity panic code ${BigInt(`0x${data.slice(-64)}`).toString(10)}`;
    }
  } catch {
    return null;
  }
  return null;
};

const categorizeFailure = (
  transaction: Web3Transaction,
  receipt: Web3TransactionReceipt | null,
  revert: Web3RevertInfo | null,
): { category: string | null; confidence: number; revert: JsonValue } => {
  if (!receipt) return { category: 'PENDING_OR_UNCONFIRMED', confidence: 0.8, revert: null };
  if (receipt.status === 'SUCCESS') return { category: null, confidence: 1, revert: null };
  const decoded = decodeRevertData(revert?.data ?? null);
  const message = [decoded, revert?.message].filter(Boolean).join(' ');
  if (/out of gas|intrinsic gas too low/i.test(message)) return { category: 'OUT_OF_GAS', confidence: 0.85, revert: { message: decoded ?? revert?.message ?? null, data: revert?.data ?? null } };
  if (/insufficient funds/i.test(message)) return { category: 'INSUFFICIENT_FUNDS', confidence: 0.85, revert: { message: decoded ?? revert?.message ?? null, data: revert?.data ?? null } };
  if (/nonce/i.test(message)) return { category: 'NONCE_CONFLICT', confidence: 0.7, revert: { message: decoded ?? revert?.message ?? null, data: revert?.data ?? null } };
  if (decoded || /execution reverted|revert/i.test(message)) return { category: 'CONTRACT_REVERT', confidence: decoded ? 0.92 : 0.72, revert: { message: decoded ?? revert?.message ?? null, data: revert?.data ?? null } };
  if (receipt.gasUsed === transaction.gasLimit && receipt.gasUsed !== '0') return { category: 'POSSIBLE_OUT_OF_GAS', confidence: 0.6, revert: revert ?? null };
  return { category: 'EXECUTION_FAILED_UNSPECIFIED', confidence: 0.45, revert: revert ?? null };
};

const evidence = (
  context: ToolExecutionContext,
  summary: string,
  output: Web3TransactionDiagnosticsOutput,
  references: SourceReference[],
): Evidence => ({
  id: `${context.investigationId}-web3-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  source: EvidenceSource.WEB3,
  type: EvidenceType.TRANSACTION,
  summary,
  content: summary,
  details: output,
  confidence: output.confidence,
  ...(references[0]?.url ? { url: references[0].url } : {}),
  ...(references.length ? { references } : {}),
  timestamp: new Date().toISOString(),
});

export class Web3TransactionDiagnosticsTool implements Tool<Web3TransactionDiagnosticsInput, JsonValue> {
  readonly name = 'web3_transaction_diagnostics';
  readonly description = 'Reads an EVM transaction, receipt, block, chain, gas data, and available revert information without signing or broadcasting.';
  readonly riskLevel = RiskLevel.READ_ONLY;
  readonly inputDefinition = {
    type: 'object' as const,
    properties: {
      transactionHash: { type: 'string', description: 'EVM transaction hash beginning with 0x and containing 64 hexadecimal characters.' },
      chain: { type: 'string', description: 'Optional expected chain name or numeric chain ID; the configured RPC remains authoritative.' },
    },
    required: ['transactionHash'],
  };

  constructor(private readonly provider: Web3DiagnosticsProvider) {}

  async execute(input: Web3TransactionDiagnosticsInput, context: ToolExecutionContext) {
    const transactionHash = input.transactionHash.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
      const error = 'Transaction hash must be 0x followed by 64 hexadecimal characters.';
      return {
        success: false,
        summary: 'Web3 transaction input is malformed.',
        error,
        data: { code: 'MALFORMED_TRANSACTION_HASH' },
        evidence: [{
          id: `${context.investigationId}-web3-invalid-${Date.now()}`,
          source: EvidenceSource.WEB3,
          type: EvidenceType.ERROR,
          summary: error,
          confidence: 1,
          timestamp: new Date().toISOString(),
        }],
      };
    }

    try {
      const [chain, transaction, receipt] = await Promise.all([
        this.provider.getChainInfo(),
        this.provider.getTransaction(transactionHash),
        this.provider.getTransactionReceipt(transactionHash),
      ]);
      if (!transaction) {
        const output: Web3TransactionDiagnosticsOutput = {
          transactionHash,
          chain,
          status: 'NOT_FOUND',
          transaction: null,
          receipt: receipt ?? null,
          block: null,
          revert: null,
          likelyFailureCategory: 'TRANSACTION_NOT_FOUND_ON_CONFIGURED_CHAIN',
          confidence: 0.9,
        };
        const summary = `Transaction ${transactionHash} was not found on ${chain.name}.`;
        return { success: true, summary, output, data: output, evidence: [evidence(context, summary, output, [])] };
      }

      const blockNumber = receipt?.blockNumber ?? transaction.blockNumber;
      const [block, revert] = await Promise.all([
        blockNumber ? this.provider.getBlock(blockNumber) : Promise.resolve(null),
        receipt?.status === 'FAILED' && blockNumber
          ? this.provider.getRevertInfo(transaction, blockNumber)
          : Promise.resolve(null),
      ]);
      const diagnosis = categorizeFailure(transaction, receipt, revert);
      const status = receipt?.status === 'SUCCESS'
        ? 'SUCCESS'
        : receipt?.status === 'FAILED'
          ? 'FAILED'
          : receipt
            ? 'UNKNOWN'
            : 'PENDING';
      const output: Web3TransactionDiagnosticsOutput = {
        transactionHash,
        chain: { ...chain, ...(input.chain ? { expectedChain: input.chain } : {}) },
        status,
        transaction,
        receipt: receipt ?? null,
        block,
        revert: diagnosis.revert,
        likelyFailureCategory: diagnosis.category,
        confidence: diagnosis.confidence,
      };
      const summary = status === 'SUCCESS'
        ? `Transaction succeeded on ${chain.name} in block ${receipt?.blockNumber ?? 'unknown'}.`
        : status === 'FAILED'
          ? `Transaction failed on ${chain.name}; likely category: ${diagnosis.category ?? 'unknown'}.`
          : `Transaction is ${status.toLowerCase()} on ${chain.name}.`;
      const url = explorerUrl(chain.chainId, transactionHash);
      const sources = url ? [{ url, title: `${chain.name} transaction explorer`, retrievedAt: new Date().toISOString() }] : [];
      return {
        success: true,
        summary,
        output,
        data: output,
        evidence: [evidence(context, summary, output, sources)],
        sources,
      };
    } catch (error) {
      const code = error instanceof Web3ProviderError ? error.code : 'WEB3_ERROR';
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 800);
      const failure = { code, message };
      return {
        success: false,
        summary: 'Web3 transaction diagnostics could not query the configured RPC provider.',
        error: message,
        data: failure,
        evidence: [{
          id: `${context.investigationId}-web3-error-${Date.now()}`,
          source: EvidenceSource.WEB3,
          type: EvidenceType.ERROR,
          summary: message,
          details: failure,
          confidence: 0.98,
          timestamp: new Date().toISOString(),
        }],
      };
    }
  }
}
