import type { InvestigationEvent, InvestigationState } from '../types/investigation.js';
import { ApprovalStatus, InvestigationEventType, InvestigationStatus } from '../types/investigation.js';
import { AgentRuntime } from '../agent/runtime.js';
import { defaultIdFactory, type IdFactory } from '../agent/state.js';
import type { ApprovalDecision, ApprovalProvider, ApprovalRequest } from '../safety/approval.js';
import type { RiskLevel } from '../tools/types.js';
import { redactSensitiveJson } from '../safety/redaction.js';

export interface RuntimeFactoryOptions {
  approvalProvider: ApprovalProvider;
  idFactory: IdFactory;
  onEvent: (event: InvestigationEvent, state: InvestigationState) => void;
}

export type RuntimeFactory = (options: RuntimeFactoryOptions) => AgentRuntime;

export interface ApprovalPrompt {
  actionId: string;
  toolName: string;
  riskLevel: RiskLevel;
  reason: string;
  purpose?: string;
  expectedResult?: string;
}

export interface InvestigationSessionSnapshot {
  investigationId: string;
  state: InvestigationState | null;
  events: InvestigationEvent[];
  pendingApproval: ApprovalPrompt | null;
  running: boolean;
}

export interface ApplicationUpdate {
  event: InvestigationEvent;
  snapshot: InvestigationSessionSnapshot;
}

type UpdateListener = (update: ApplicationUpdate) => void;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const promptFromRequest = (request: ApprovalRequest): ApprovalPrompt => ({
  actionId: request.action.id,
  toolName: request.toolName,
  riskLevel: request.riskLevel,
  reason: String(redactSensitiveJson(request.reason)),
  ...(request.action.purpose !== undefined ? { purpose: String(redactSensitiveJson(request.action.purpose)) } : {}),
  ...(request.action.expectedResult !== undefined ? { expectedResult: String(redactSensitiveJson(request.action.expectedResult)) } : {}),
});

const promptFromState = (state: InvestigationState | null): ApprovalPrompt | null => {
  if (!state || state.approval.status !== ApprovalStatus.PENDING || !state.currentAction || !state.approval.toolName || !state.approval.riskLevel) return null;
  return {
    actionId: state.currentAction.id,
    toolName: state.approval.toolName,
    riskLevel: state.approval.riskLevel,
    reason: String(redactSensitiveJson(state.approval.reason ?? 'Approval required.')),
    ...(state.currentAction.purpose !== undefined ? { purpose: String(redactSensitiveJson(state.currentAction.purpose)) } : {}),
    ...(state.currentAction.expectedResult !== undefined ? { expectedResult: String(redactSensitiveJson(state.currentAction.expectedResult)) } : {}),
  };
};

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
}

/** Bridges the runtime's callback approval contract to an external transport. */
export class DeferredApprovalProvider implements ApprovalProvider {
  private readonly pending = new Map<string, PendingApproval>();

  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const key = `${request.investigationId}:${request.action.id}`;
    return new Promise((resolve) => {
      this.pending.set(key, { request, resolve });
    });
  }

  getPending(investigationId: string): ApprovalPrompt | null {
    for (const pending of this.pending.values()) {
      if (pending.request.investigationId === investigationId) return promptFromRequest(pending.request);
    }
    return null;
  }

  decide(investigationId: string, approved: boolean, reason?: string): boolean {
    for (const [key, pending] of this.pending.entries()) {
      if (pending.request.investigationId !== investigationId) continue;
      this.pending.delete(key);
      pending.resolve({
        approved,
        ...(reason !== undefined ? { reason: String(redactSensitiveJson(reason)) } : {}),
      });
      return true;
    }
    return false;
  }
}

interface SessionRecord {
  investigationId: string;
  state: InvestigationState | null;
  events: InvestigationEvent[];
  listeners: Set<UpdateListener>;
  approvalProvider: DeferredApprovalProvider;
  completion: Promise<InvestigationState>;
  running: boolean;
}

/** Presentation/service boundary for one existing AgentRuntime per investigation. */
export class BimoApplicationService {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(private readonly runtimeFactory: RuntimeFactory) {}

  start(userProblem: string): { investigationId: string } {
    const investigationId = defaultIdFactory('investigation');
    const approvalProvider = new DeferredApprovalProvider();
    const idFactory: IdFactory = (prefix) => prefix === 'investigation' ? investigationId : defaultIdFactory(prefix);
    const session: SessionRecord = {
      investigationId,
      state: null,
      events: [],
      listeners: new Set(),
      approvalProvider,
      completion: Promise.resolve(null as unknown as InvestigationState),
      running: true,
    };
    this.sessions.set(investigationId, session);

    let runtime: AgentRuntime;
    try {
      runtime = this.runtimeFactory({
        approvalProvider,
        idFactory,
        onEvent: (event, state) => this.handleEvent(session, event, state),
      });
    } catch (error) {
      session.running = false;
      throw error;
    }

    session.completion = runtime.investigate(userProblem).then((state) => {
      session.state = clone(state);
      session.running = false;
      return clone(state);
    }).catch((error) => {
      session.running = false;
      throw error;
    });
    return { investigationId };
  }

  get(investigationId: string): InvestigationSessionSnapshot | null {
    const session = this.sessions.get(investigationId);
    return session ? this.snapshot(session) : null;
  }

  subscribe(investigationId: string, listener: UpdateListener): () => void {
    const session = this.sessions.get(investigationId);
    if (!session) throw new Error(`Investigation "${investigationId}" was not found.`);
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  decideApproval(investigationId: string, approved: boolean, reason?: string): boolean {
    const session = this.sessions.get(investigationId);
    return session ? session.approvalProvider.decide(investigationId, approved, reason) : false;
  }

  async waitForCompletion(investigationId: string): Promise<InvestigationState> {
    const session = this.sessions.get(investigationId);
    if (!session) throw new Error(`Investigation "${investigationId}" was not found.`);
    return session.completion;
  }

  private handleEvent(session: SessionRecord, event: InvestigationEvent, state: InvestigationState): void {
    session.state = clone(state);
    session.events.push(clone(event));
    if (event.type === InvestigationEventType.INVESTIGATION_COMPLETED || event.type === InvestigationEventType.INVESTIGATION_FAILED) {
      session.running = false;
    }
    const update = { event: clone(event), snapshot: this.snapshot(session) };
    for (const listener of session.listeners) {
      try {
        listener(update);
      } catch {
        // A presentation subscriber cannot affect the runtime.
      }
    }
  }

  private snapshot(session: SessionRecord): InvestigationSessionSnapshot {
    const state = session.state ? clone(session.state) : null;
    return {
      investigationId: session.investigationId,
      state,
      events: clone(session.events),
      pendingApproval: session.approvalProvider.getPending(session.investigationId) ?? promptFromState(state),
      running: session.running && state?.status !== InvestigationStatus.COMPLETED && state?.status !== InvestigationStatus.FAILED,
    };
  }
}
