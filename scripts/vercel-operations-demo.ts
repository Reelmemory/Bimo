import { runVercelOperationsDemo } from '../src/index.js';
import { createConsoleApprovalProvider } from './console-approval.js';

const deploymentIdOrUrl = process.argv[2];
if (!deploymentIdOrUrl) {
  console.error('Usage: npm run demo:vercel -- <deployment-id-or-url>');
  process.exitCode = 1;
} else {
  try {
    const result = await runVercelOperationsDemo(deploymentIdOrUrl, createConsoleApprovalProvider());
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
