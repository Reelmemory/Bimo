import type { InvestigationState, PlannedAction } from '../types/investigation.js';
import { RiskLevel } from '../tools/types.js';

export interface ApprovalRequest {
  investigationId: string;
  userProblem: string;
  action: PlannedAction;
  toolName: string;
  riskLevel: RiskLevel;
  reason: string;
  state: InvestigationState;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

export interface ApprovalProvider {
  requestApproval(request: ApprovalRequest): ApprovalDecision | Promise<ApprovalDecision>;
}

export class CallbackApprovalProvider implements ApprovalProvider {
  constructor(
    private readonly callback: (request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>,
  ) {}

  requestApproval(request: ApprovalRequest): ApprovalDecision | Promise<ApprovalDecision> {
    return this.callback(request);
  }
}

export const approvingProvider = (): ApprovalProvider =>
  new CallbackApprovalProvider(() => ({ approved: true }));

export const rejectingProvider = (reason = 'Approval was rejected'): ApprovalProvider =>
  new CallbackApprovalProvider(() => ({ approved: false, reason }));
