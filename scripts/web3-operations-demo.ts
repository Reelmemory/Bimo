import { runWeb3OperationsDemo } from '../src/index.js';

const transactionHash = process.argv[2];
if (!transactionHash) {
  console.error('Usage: npm run demo:web3 -- <transaction-hash>');
  process.exitCode = 1;
} else {
  try {
    const result = await runWeb3OperationsDemo(transactionHash);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
