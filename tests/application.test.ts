import { describe, expect, it } from 'vitest';
import { createDemoRuntimeFactory } from '../src/application/demo.js';
import { BimoApplicationService } from '../src/application/service.js';

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for application service state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('BIMO application service boundary', () => {
  it('streams real runtime events and routes approval decisions back to the runtime', async () => {
    const service = new BimoApplicationService(createDemoRuntimeFactory());
    const started = service.start('My deployment is failing.');
    const updates: string[] = [];
    const unsubscribe = service.subscribe(started.investigationId, (update) => updates.push(update.event.type));

    await waitFor(() => service.get(started.investigationId)?.pendingApproval !== null);
    expect(service.get(started.investigationId)?.pendingApproval?.toolName).toBe('mock_deploy');
    expect(service.decideApproval(started.investigationId, true)).toBe(true);

    const result = await service.waitForCompletion(started.investigationId);
    unsubscribe();

    expect(result.finalResult?.outcome).toBe('SUCCESS');
    expect(updates).toContain('APPROVAL_REQUESTED');
    expect(updates).toContain('APPROVAL_DECIDED');
    expect(updates).toContain('INVESTIGATION_COMPLETED');
  });

  it('keeps approval rejection inside the runtime boundary', async () => {
    const service = new BimoApplicationService(createDemoRuntimeFactory());
    const started = service.start('Do not change my deployment.');

    await waitFor(() => service.get(started.investigationId)?.pendingApproval !== null);
    expect(service.decideApproval(started.investigationId, false, 'Operator denied the action.')).toBe(true);

    const result = await service.waitForCompletion(started.investigationId);
    expect(result.finalResult?.outcome).toBe('REJECTED');
    expect(result.actionHistory?.some((action) => action.toolName === 'mock_deploy')).toBe(false);
  });
});
