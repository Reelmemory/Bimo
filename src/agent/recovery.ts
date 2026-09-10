import type { ActionPlan, InvestigationState, PlannedAction } from '../types/investigation.js';

export interface RecoveryHandler {
  createRecoveryPlan(state: InvestigationState): ActionPlan | null | Promise<ActionPlan | null>;
}

export type RecoveryFactory = (state: InvestigationState) => ActionPlan | null | Promise<ActionPlan | null>;

export class CallbackRecoveryHandler implements RecoveryHandler {
  constructor(private readonly factory: RecoveryFactory) {}

  createRecoveryPlan(state: InvestigationState): ActionPlan | null | Promise<ActionPlan | null> {
    return this.factory(state);
  }
}

export class EvidenceRecoveryHandler implements RecoveryHandler {
  constructor(
    private readonly toolName: string,
    private readonly input: PlannedAction['input'] = null,
  ) {}

  createRecoveryPlan(state: InvestigationState): ActionPlan {
    const attempt = state.recoveryAttempts + 1;
    return {
      id: `plan-recovery-${attempt}`,
      objective: 'Collect additional evidence before revising the plan',
      actions: [{
        id: `action-recovery-${attempt}`,
        toolName: this.toolName,
        ...(this.input !== undefined ? { input: this.input } : {}),
        rationale: 'Verification failed; gather fresh evidence before trying again.',
      }],
    };
  }
}
