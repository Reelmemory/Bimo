export interface ApprovalPrompt {
  actionId: string;
  toolName: string;
  riskLevel: string;
  reason: string;
  purpose?: string;
  expectedResult?: string;
}

export interface InvestigationSnapshot {
  investigationId: string;
  state: {
    id: string;
    userProblem: string;
    status: string;
    observations: string[];
    evidence: Array<Record<string, unknown>>;
    currentHypothesis: { statement: string; confidence?: number } | null;
    currentAction: { toolName: string; purpose?: string } | null;
    verification: { status: string; summary: string } | null;
    approval: { status: string; reason?: string };
    recoveryAttempts: number;
    finalResult: { outcome: string; summary: string; actionsExecuted: number; recoveryAttempts: number } | null;
  } | null;
  events: Array<{ id: string; type: string; timestamp: string; data: unknown }>;
  pendingApproval: ApprovalPrompt | null;
  running: boolean;
}

export interface InvestigationUpdate {
  event: { id: string; type: string; timestamp: string; data: unknown };
  snapshot: InvestigationSnapshot;
}

export const startInvestigation = async (problem: string): Promise<{ investigationId: string }> => {
  const response = await fetch('/api/investigations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ problem }),
  });
  const payload = await response.json() as { investigationId?: string; error?: string };
  if (!response.ok || !payload.investigationId) throw new Error(payload.error ?? 'BIMO could not start the investigation.');
  return { investigationId: payload.investigationId };
};

export const connectInvestigation = (
  investigationId: string,
  onSnapshot: (snapshot: InvestigationSnapshot) => void,
  onUpdate: (update: InvestigationUpdate) => void,
  onError: (message: string) => void,
): EventSource => {
  const source = new EventSource(`/api/investigations/${encodeURIComponent(investigationId)}/events`);
  source.addEventListener('snapshot', (event) => {
    onSnapshot(JSON.parse((event as MessageEvent).data) as InvestigationSnapshot);
  });
  source.addEventListener('update', (event) => {
    onUpdate(JSON.parse((event as MessageEvent).data) as InvestigationUpdate);
  });
  source.addEventListener('error', () => onError('The investigation event stream disconnected.'));
  return source;
};

export const decideApproval = async (
  investigationId: string,
  approved: boolean,
): Promise<void> => {
  const response = await fetch(`/api/investigations/${encodeURIComponent(investigationId)}/approval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approved, reason: approved ? 'Approved from BIMO workspace.' : 'Denied from BIMO workspace.' }),
  });
  const payload = await response.json() as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? 'BIMO could not record the approval decision.');
};
