import { runAIDeploymentDemo } from '../src/index.js';

try {
  const result = await runAIDeploymentDemo();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
