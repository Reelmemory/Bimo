import { toJsonValue, type JsonValue } from '../../types/investigation.js';
import type {
  Web3Block,
  Web3ChainInfo,
  Web3DiagnosticsProvider,
  Web3RevertInfo,
  Web3Transaction,
  Web3TransactionReceipt,
} from './types.js';

export type Web3ErrorCode = 'AUTHENTICATION' | 'RATE_LIMIT' | 'TIMEOUT' | 'RPC_ERROR' | 'INVALID_RESPONSE' | 'NOT_FOUND';

export class Web3ConfigurationError extends Error {
  constructor(message = 'WEB3_RPC_URL is required to use the Web3 diagnostics provider.') {
    super(message);
    this.name = 'Web3ConfigurationError';
  }
}

export class Web3ProviderError extends Error {
  constructor(
    readonly code: Web3ErrorCode,
    message: string,
    readonly data?: JsonValue,
  ) {
    super(message);
    this.name = 'Web3ProviderError';
  }
}

export interface JsonRpcWeb3ProviderOptions {
  rpcUrl?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const stringValue = (value: unknown): string | null => typeof value === 'string' ? value : null;

const hexToDecimal = (value: unknown): string | null => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) return null;
  try {
    return BigInt(value).toString(10);
  } catch {
    return null;
  }
};

const hexTimestamp = (value: unknown): string | null => {
  const decimal = hexToDecimal(value);
  if (!decimal) return null;
  const milliseconds = Number(decimal) * 1000;
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
};

const chainName = (chainId: string): string => ({
  '1': 'Ethereum Mainnet',
  '10': 'Optimism',
  '56': 'BNB Smart Chain',
  '137': 'Polygon',
  '8453': 'Base',
  '42161': 'Arbitrum One',
  '43114': 'Avalanche C-Chain',
  '11155111': 'Ethereum Sepolia',
}[chainId] ?? `Unknown EVM chain (${chainId})`);

const safeRpcMessage = (value: unknown): string => {
  const raw = typeof value === 'string' ? value : String(value);
  return raw
    .replace(/bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s]+/gi, '[RPC_ENDPOINT_REDACTED]')
    .slice(0, 800);
};

const extractRevertData = (value: unknown): string | null => {
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) return value;
  const record = asRecord(value);
  if (!record) return null;
  for (const candidate of [record.data, record.result, record.return]) {
    const found = extractRevertData(candidate);
    if (found) return found;
  }
  return null;
};

export class JsonRpcWeb3Provider implements Web3DiagnosticsProvider {
  private readonly rpcUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;
  private requestId = 0;

  constructor(options: JsonRpcWeb3ProviderOptions = {}) {
    const rpcUrl = (options.rpcUrl ?? process.env.WEB3_RPC_URL)?.trim();
    if (!rpcUrl) throw new Web3ConfigurationError();
    try {
      const parsed = new URL(rpcUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol');
    } catch {
      throw new Web3ConfigurationError('WEB3_RPC_URL must be a valid http or https URL.');
    }
    this.rpcUrl = rpcUrl;
    this.timeoutMs = Math.min(30_000, Math.max(100, options.timeoutMs ?? 12_000));
    this.fetcher = options.fetcher ?? fetch;
  }

  private async call(method: string, params: JsonValue[]): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        this.fetcher(this.rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.requestId, method, params }),
          signal: controller.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Web3ProviderError('TIMEOUT', `Web3 RPC request timed out after ${this.timeoutMs}ms.`));
          }, this.timeoutMs);
        }),
      ]);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Web3ProviderError('AUTHENTICATION', 'Web3 RPC authentication failed.');
        if (response.status === 429) throw new Web3ProviderError('RATE_LIMIT', 'Web3 RPC rate limit reached.');
        throw new Web3ProviderError('RPC_ERROR', `Web3 RPC returned HTTP ${response.status}.`);
      }
      const payload = await response.json() as JsonRpcResponse;
      if (payload.error) {
        const message = safeRpcMessage(payload.error.message ?? `RPC error ${payload.error.code ?? 'unknown'}`);
        throw new Web3ProviderError('RPC_ERROR', message, toJsonValue(payload.error.data));
      }
      if (!Object.prototype.hasOwnProperty.call(payload, 'result')) {
        throw new Web3ProviderError('INVALID_RESPONSE', 'Web3 RPC response did not contain a result.');
      }
      return payload.result;
    } catch (error) {
      if (error instanceof Web3ProviderError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/abort|timeout/i.test(message)) throw new Web3ProviderError('TIMEOUT', `Web3 RPC request timed out after ${this.timeoutMs}ms.`);
      throw new Web3ProviderError('RPC_ERROR', `Web3 RPC request failed: ${safeRpcMessage(message)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async getChainInfo(): Promise<Web3ChainInfo> {
    const [chainIdHex, gasPriceHex, latestBlockRaw] = await Promise.all([
      this.call('eth_chainId', []),
      this.call('eth_gasPrice', []),
      this.call('eth_getBlockByNumber', ['latest', false]),
    ]);
    const chainId = hexToDecimal(chainIdHex);
    if (!chainId) throw new Web3ProviderError('INVALID_RESPONSE', 'Web3 RPC returned an invalid chain ID.');
    const latestBlock = asRecord(latestBlockRaw);
    return {
      chainId,
      name: chainName(chainId),
      latestBlockNumber: hexToDecimal(latestBlock?.number),
      gasPriceWei: hexToDecimal(gasPriceHex),
    };
  }

  async getTransaction(transactionHash: string): Promise<Web3Transaction | null> {
    const raw = asRecord(await this.call('eth_getTransactionByHash', [transactionHash]));
    if (!raw) return null;
    const hash = stringValue(raw.hash);
    const from = stringValue(raw.from);
    if (!hash || !from) throw new Web3ProviderError('INVALID_RESPONSE', 'Web3 RPC returned a malformed transaction.');
    return {
      hash,
      from,
      to: stringValue(raw.to),
      valueWei: hexToDecimal(raw.value) ?? '0',
      gasLimit: hexToDecimal(raw.gas) ?? '0',
      gasPriceWei: hexToDecimal(raw.gasPrice),
      maxFeePerGasWei: hexToDecimal(raw.maxFeePerGas),
      maxPriorityFeePerGasWei: hexToDecimal(raw.maxPriorityFeePerGas),
      nonce: hexToDecimal(raw.nonce) ?? '0',
      input: stringValue(raw.input) ?? stringValue(raw.data) ?? '0x',
      blockNumber: hexToDecimal(raw.blockNumber),
    };
  }

  async getTransactionReceipt(transactionHash: string): Promise<Web3TransactionReceipt | null> {
    const raw = asRecord(await this.call('eth_getTransactionReceipt', [transactionHash]));
    if (!raw) return null;
    const hash = stringValue(raw.transactionHash);
    if (!hash) throw new Web3ProviderError('INVALID_RESPONSE', 'Web3 RPC returned a malformed transaction receipt.');
    const statusHex = stringValue(raw.status);
    return {
      transactionHash: hash,
      status: statusHex === '0x1' ? 'SUCCESS' : statusHex === '0x0' ? 'FAILED' : 'UNKNOWN',
      blockNumber: hexToDecimal(raw.blockNumber),
      gasUsed: hexToDecimal(raw.gasUsed),
      effectiveGasPriceWei: hexToDecimal(raw.effectiveGasPrice),
      contractAddress: stringValue(raw.contractAddress),
    };
  }

  async getBlock(blockNumber: string): Promise<Web3Block | null> {
    const tag = /^0x/i.test(blockNumber) ? blockNumber : `0x${BigInt(blockNumber).toString(16)}`;
    const raw = asRecord(await this.call('eth_getBlockByNumber', [tag, false]));
    if (!raw) return null;
    const number = hexToDecimal(raw.number);
    if (!number) throw new Web3ProviderError('INVALID_RESPONSE', 'Web3 RPC returned a malformed block.');
    return {
      number,
      hash: stringValue(raw.hash),
      timestamp: hexTimestamp(raw.timestamp),
      baseFeePerGasWei: hexToDecimal(raw.baseFeePerGas),
    };
  }

  async getRevertInfo(transaction: Web3Transaction, blockNumber: string): Promise<Web3RevertInfo | null> {
    const blockTag = /^0x/i.test(blockNumber) ? blockNumber : `0x${BigInt(blockNumber).toString(16)}`;
    try {
      await this.call('eth_call', [{
        from: transaction.from,
        ...(transaction.to ? { to: transaction.to } : {}),
        data: transaction.input,
        value: `0x${BigInt(transaction.valueWei).toString(16)}`,
        gas: `0x${BigInt(transaction.gasLimit).toString(16)}`,
      }, blockTag]);
      return null;
    } catch (error) {
      if (error instanceof Web3ProviderError && error.code === 'RPC_ERROR') {
        return { message: error.message, data: extractRevertData(error.data) };
      }
      throw error;
    }
  }
}

export const createJsonRpcWeb3Provider = (options: JsonRpcWeb3ProviderOptions = {}) => new JsonRpcWeb3Provider(options);
