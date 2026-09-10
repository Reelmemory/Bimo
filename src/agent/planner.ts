import { InvestigationStatus, type ActionPlan, type InvestigationState, type PlannedAction } from '../types/investigation.js';

export interface Planner {
  createPlan(state: InvestigationState): ActionPlan | null | Promise<ActionPlan | null>;
}

export type PlanFactory = (state: InvestigationState) => ActionPlan | null | Promise<ActionPlan | null>;

export class CallbackPlanner implements Planner {
  constructor(private readonly factory: PlanFactory) {}

  createPlan(state: InvestigationState): ActionPlan | null | Promise<ActionPlan | null> {
    return this.factory(state);
  }
}

export interface BasicPlannerOptions {
  initialDiagnosticTool: string;
  remediationTool: string;
  initialDiagnosticInput?: PlannedAction['input'];
  remediationInput?: PlannedAction['input'];
}

export class BasicPlanner implements Planner {
  constructor(private readonly options: BasicPlannerOptions) {}

  createPlan(state: InvestigationState): ActionPlan | null {
    if (state.status === InvestigationStatus.READING || state.evidence.length === 0) {
      return {
        id: `plan-read-${state.recoveryAttempts + 1}`,
        objective: 'Collect diagnostic evidence',
        actions: [{
          id: `action-read-${state.recoveryAttempts + 1}`,
          toolName: this.options.initialDiagnosticTool,
          input: this.options.initialDiagnosticInput ?? null,
          purpose: 'Collect diagnostic evidence',
          expectedResult: 'Structured evidence relevant to the reported problem',
          rationale: state.recommendedNextStep ?? 'Read-only diagnostics are required before changing anything.',
        }],
      };
    }

    const rationale = state.recommendedNextStep
      ?? state.currentHypothesis?.statement
      ?? 'Apply the best available remediation based on the collected evidence.';
    return {
      id: `plan-remediate-${state.recoveryAttempts + 1}`,
      objective: 'Apply the best available remediation',
      actions: [{
        id: `action-remediate-${state.recoveryAttempts + 1}`,
        toolName: this.options.remediationTool,
        input: this.options.remediationInput ?? null,
        purpose: 'Apply the best available remediation',
        expectedResult: 'The underlying issue is changed or more actionable evidence is returned',
          rationale,
      }],
    };
  }
}
