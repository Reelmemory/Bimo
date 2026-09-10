import type {
  ActionResult,
  InvestigationState,
  PlannedAction,
  VerificationResult,
} from '../types/investigation.js';
import { VerificationStatus } from '../types/investigation.js';

export interface Verifier {
  createVerificationAction(state: InvestigationState): PlannedAction | null | Promise<PlannedAction | null>;
  evaluate(state: InvestigationState, actionResult: ActionResult): VerificationResult;
}

export interface ToolVerifierOptions {
  toolName: string;
  input?: PlannedAction['input'];
  inputFactory?: (state: InvestigationState) => PlannedAction['input'];
  evaluateOutput?: (output: ActionResult['output'], actionResult: ActionResult) => VerificationResult;
}

export class ToolVerifier implements Verifier {
  constructor(private readonly options: ToolVerifierOptions) {}

  createVerificationAction(state: InvestigationState): PlannedAction {
    return {
      id: `action-verify-${state.recoveryAttempts + 1}`,
      toolName: this.options.toolName,
      input: this.options.inputFactory?.(state) ?? this.options.input ?? null,
      purpose: 'Verify the requested outcome',
      expectedResult: 'A structured healthy/unhealthy verification result',
      rationale: 'Check whether the requested outcome is now healthy.',
    };
  }

  evaluate(_state: InvestigationState, actionResult: ActionResult): VerificationResult {
    if (this.options.evaluateOutput && actionResult.output !== undefined) {
      return this.options.evaluateOutput(actionResult.output, actionResult);
    }
    return {
      status: actionResult.success ? VerificationStatus.PASSED : VerificationStatus.FAILED,
      summary: actionResult.success ? 'Verification passed.' : actionResult.error ?? 'Verification failed.',
    };
  }
}
