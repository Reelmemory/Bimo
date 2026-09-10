import type { InvestigationState, PlannedAction } from '../types/investigation.js';
import { RiskLevel } from '../tools/types.js';

export enum PermissionDecision {
  ALLOWED = 'ALLOWED',
  REQUIRES_APPROVAL = 'REQUIRES_APPROVAL',
  DENIED = 'DENIED',
}

export interface PermissionPolicy {
  evaluate(riskLevel: RiskLevel, action: PlannedAction, state: InvestigationState):
    | PermissionDecision
    | Promise<PermissionDecision>;
}

export interface DefaultPermissionPolicyOptions {
  allowReversible?: boolean;
}

export class DefaultPermissionPolicy implements PermissionPolicy {
  private readonly allowReversible: boolean;

  constructor(options: DefaultPermissionPolicyOptions = {}) {
    this.allowReversible = options.allowReversible ?? true;
  }

  evaluate(riskLevel: RiskLevel): PermissionDecision {
    if (riskLevel === RiskLevel.READ_ONLY) return PermissionDecision.ALLOWED;
    if (riskLevel === RiskLevel.REVERSIBLE) {
      return this.allowReversible ? PermissionDecision.ALLOWED : PermissionDecision.DENIED;
    }
    return PermissionDecision.REQUIRES_APPROVAL;
  }
}

export const requiresApproval = (riskLevel: RiskLevel): boolean => riskLevel === RiskLevel.CONSEQUENTIAL;
