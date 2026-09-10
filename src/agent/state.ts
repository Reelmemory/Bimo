import type { Evidence, InvestigationState } from '../types/investigation.js';
import { ApprovalStatus, EvidenceSource, EvidenceType, InvestigationStatus } from '../types/investigation.js';
import { redactSensitiveJson } from '../safety/redaction.js';

export type IdFactory = (prefix: string) => string;

export const defaultIdFactory: IdFactory = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const createInvestigationState = (
  userProblem: string,
  idFactory: IdFactory = defaultIdFactory,
): InvestigationState => {
  const safeUserProblem = String(redactSensitiveJson(userProblem));
  const userEvidence: Evidence = {
    id: idFactory('evidence'),
    source: EvidenceSource.USER,
    type: EvidenceType.USER_PROBLEM,
    summary: 'User-reported problem',
    content: safeUserProblem,
    confidence: 1,
    timestamp: new Date().toISOString(),
  };

  return {
    id: idFactory('investigation'),
    userProblem: safeUserProblem,
    status: InvestigationStatus.INITIALIZING,
    observations: [],
    evidence: [userEvidence],
    hypotheses: [],
    actionHistory: [],
    events: [],
    reasoningSummary: null,
    recommendedNextStep: null,
    currentHypothesis: null,
    plan: null,
    currentAction: null,
    actionResult: null,
    verification: null,
    approval: { status: ApprovalStatus.NOT_REQUIRED },
    recoveryAttempts: 0,
    finalResult: null,
  };
};
