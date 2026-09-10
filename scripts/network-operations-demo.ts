import { runNetworkOperationsDemo } from '../src/index.js';

const url = process.argv[2];
if (!url) {
  console.error('Usage: npm run demo:network -- <url>');
  process.exitCode = 1;
} else {
  try {
    const result = await runNetworkOperationsDemo(url);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
