import type { JsonValue } from '../../types/investigation.js';

export interface Web3ChainInfo {
  [key: string]: JsonValue;
  chainId: string;
  name: string;
  latestBlockNumber: string | null;
  gasPriceWei: string | null;
}

export interface Web3Transaction {
  [key: string]: JsonValue;
  hash: string;
  from: string;
  to: string | null;
  valueWei: string;
  gasLimit: string;
  gasPriceWei: string | null;
  maxFeePerGasWei: string | null;
  maxPriorityFeePerGasWei: string | null;
  nonce: string;
  input: string;
  blockNumber: string | null;
}

export interface Web3TransactionReceipt {
  [key: string]: JsonValue;
  transactionHash: string;
  status: 'SUCCESS' | 'FAILED' | 'UNKNOWN';
  blockNumber: string | null;
  gasUsed: string | null;
  effectiveGasPriceWei: string | null;
  contractAddress: string | null;
}

export interface Web3Block {
  [key: string]: JsonValue;
  number: string;
  hash: string | null;
  timestamp: string | null;
  baseFeePerGasWei: string | null;
}

export interface Web3RevertInfo {
  [key: string]: JsonValue;
  message: string | null;
  data: string | null;
}

export interface Web3DiagnosticsProvider {
  getChainInfo(): Promise<Web3ChainInfo>;
  getTransaction(transactionHash: string): Promise<Web3Transaction | null>;
  getTransactionReceipt(transactionHash: string): Promise<Web3TransactionReceipt | null>;
  getBlock(blockNumber: string): Promise<Web3Block | null>;
  getRevertInfo(transaction: Web3Transaction, blockNumber: string): Promise<Web3RevertInfo | null>;
}
