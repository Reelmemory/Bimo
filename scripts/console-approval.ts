import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { CallbackApprovalProvider } from '../src/safety/approval.js';

export const createConsoleApprovalProvider = () => new CallbackApprovalProvider(async (request) => {
  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question(
      `Approval required for ${request.toolName} (${request.riskLevel}). ${request.reason}\nApprove? [y/N] `,
    );
    const approved = /^(y|yes)$/i.test(answer.trim());
    return { approved, reason: approved ? 'Approved in the CLI demo.' : 'Rejected in the CLI demo.' };
  } finally {
    readline.close();
  }
});
