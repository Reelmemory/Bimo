import { createInvestigationState, defaultIdFactory, type IdFactory } from './state.js';
import { createAIReasonerInput, validateAIReasoningResult, type AIReasoner } from './ai-reasoner.js';
import { recordInvestigationEvent } from './events.js';
import type { Planner } from './planner.js';
import type { Reasoner } from './reasoning.js';
import type { RecoveryHandler } from './recovery.js';
import type { Verifier } from './verifier.js';
import {
  ApprovalStatus,
  InvestigationStatus,
  VerificationStatus,
  type ActionPlan,
  type ActionResult,
  type FinalOutcome,
  type InvestigationState,
  type PlannedAction,
  type VerificationResult,
  InvestigationEventType,
  toJsonValue,
} from '../types/investigation.js';
import { DefaultPermissionPolicy, PermissionDecision, type PermissionPolicy } from '../safety/permissions.js';
import type { ApprovalProvider } from '../safety/approval.js';
import { redactActionArguments, redactEvidence, redactSensitiveJson, redactSourceReference } from '../safety/redaction.js';
import { ToolRegistry } from '../tools/registry.js';
import { validateToolArguments } from '../tools/validation.js';
import type { ToolExecutionContext } from '../tools/types.js';

export interface AgentRuntimeOptions {
  registry: ToolRegistry;
  reasoner?: Reasoner;
  planner?: Planner;
  verifier: Verifier;
  recovery?: RecoveryHandler;
  permissionPolicy?: PermissionPolicy;
  approvalProvider?: ApprovalProvider;
  maxRecoveryAttempts?: number;
  idFactory?: IdFactory;
  aiReasoner?: AIReasoner;
  maxReasoningIterations?: number;
  maxToolCalls?: number;
  onEvent?: (event: import('../types/investigation.js').InvestigationEvent, state: InvestigationState) => void;
}

export class AgentRuntime {
  private readonly maxRecoveryAttempts: number;
  private readonly permissionPolicy: PermissionPolicy;
  private readonly maxReasoningIterations: number;
  private readonly maxToolCalls: number;
  private readonly actionsExecuted = new WeakMap<InvestigationState, number>();

  constructor(private readonly options: AgentRuntimeOptions) {
    this.maxRecoveryAttempts = options.maxRecoveryAttempts ?? 3;
    if (!Number.isInteger(this.maxRecoveryAttempts) || this.maxRecoveryAttempts < 0) {
      throw new Error('maxRecoveryAttempts must be a non-negative integer');
    }
    this.permissionPolicy = options.permissionPolicy ?? new DefaultPermissionPolicy();
    this.maxReasoningIterations = options.maxReasoningIterations ?? 8;
    this.maxToolCalls = options.maxToolCalls ?? 12;
    for (const [name, value] of [
      ['maxReasoningIterations', this.maxReasoningIterations],
      ['maxToolCalls', this.maxToolCalls],
    ] as const) {
      if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
    }
  }

  async investigate(userProblem: string): Promise<InvestigationState> {
    const state = createInvestigationState(userProblem, this.options.idFactory ?? defaultIdFactory);
    this.actionsExecuted.set(state, 0);
    this.recordEvent(state, InvestigationEventType.INVESTIGATION_STARTED, toJsonValue({
      status: state.status,
      userProblem: state.userProblem,
    }));

    if (this.options.aiReasoner) {
      try {
        return await this.investigateWithAI(state);
      } catch (error) {
        return this.finish(state, 'FAILED', error instanceof Error ? error.message : String(error));
      }
    }
    if (!this.options.reasoner || !this.options.planner) return this.failState(state, 'A deterministic reasoner and planner are required when AI reasoning is not configured.');
    const { reasoner, planner } = this.options;

    try {
      state.status = InvestigationStatus.READING;
      const initialPlan = await planner.createPlan(state);
      if (initialPlan && initialPlan.actions.length > 0) {
        state.plan = initialPlan;
        if (!(await this.executePlan(state, initialPlan))) return state;
      }

      for (let cycle = 0; cycle <= this.maxRecoveryAttempts; cycle += 1) {
        state.status = InvestigationStatus.REASONING;
        const reasoning = await reasoner.analyze(state);
        if (reasoning.observation) state.observations.push(String(redactSensitiveJson(reasoning.observation)));
        if (reasoning.evidence?.length) this.appendEvidence(state, reasoning.evidence);
        state.reasoningSummary = reasoning.reasoningSummary
          ? String(redactSensitiveJson(reasoning.reasoningSummary)) : null;
        state.recommendedNextStep = reasoning.recommendedNextStep
          ? String(redactSensitiveJson(reasoning.recommendedNextStep)) : null;
        const safeHypothesis = {
          ...reasoning.hypothesis,
          statement: String(redactSensitiveJson(reasoning.hypothesis.statement)),
          ...(reasoning.hypothesis.rationale !== undefined
            ? { rationale: String(redactSensitiveJson(reasoning.hypothesis.rationale)) } : {}),
        };
        state.currentHypothesis = safeHypothesis;
        state.hypotheses.push(safeHypothesis);
        this.recordEvent(state, InvestigationEventType.REASONING, redactSensitiveJson(toJsonValue({
          decision: 'DETERMINISTIC_REASONING',
          hypothesis: safeHypothesis,
          reasoningSummary: reasoning.reasoningSummary ?? null,
          recommendedNextStep: reasoning.recommendedNextStep ?? null,
        })));

        state.status = InvestigationStatus.PLANNING;
        const plan = await planner.createPlan(state);
        if (!plan || plan.actions.length === 0) {
          return this.finish(state, 'FAILED', 'No executable action plan was produced.');
        }
        state.plan = plan;
        if (!(await this.executePlan(state, plan))) return state;

        state.status = InvestigationStatus.VERIFYING;
        const verificationAction = await this.options.verifier.createVerificationAction(state);
        if (!verificationAction) {
          return this.finish(state, 'FAILED', 'No verification action was produced.');
        }
        state.currentAction = verificationAction;
        if (!(await this.executeAction(state, verificationAction))) return state;
        if (!state.actionResult) return this.finish(state, 'FAILED', 'Verification produced no action result.');
        state.verification = this.sanitizeVerification(this.options.verifier.evaluate(state, state.actionResult));
        if (state.verification.evidence?.length) this.appendEvidence(state, state.verification.evidence);
        state.observations.push(`Verification ${state.verification.status.toLowerCase()}: ${state.verification.summary}`);
        this.recordEvent(state, InvestigationEventType.VERIFICATION_RESULT, toJsonValue(state.verification));

        if (state.verification.status === VerificationStatus.PASSED) {
          return this.finish(state, 'SUCCESS', state.verification.summary);
        }

        if (cycle === this.maxRecoveryAttempts) {
          state.recoveryAttempts = this.maxRecoveryAttempts;
          return this.finish(state, 'MAX_RECOVERY_ATTEMPTS', 'Verification continued to fail after the maximum recovery attempts.');
        }

        state.status = InvestigationStatus.RECOVERING;
        state.recoveryAttempts += 1;
        if (this.options.recovery) {
          const recoveryPlan = await this.options.recovery.createRecoveryPlan(state);
          if (recoveryPlan && recoveryPlan.actions.length > 0) {
            state.plan = recoveryPlan;
            if (!(await this.executePlan(state, recoveryPlan))) return state;
          }
        }
      }
    } catch (error) {
      return this.finish(state, 'FAILED', error instanceof Error ? error.message : String(error));
    }

    return this.finish(state, 'FAILED', 'Investigation ended without a result.');
  }

  run(userProblem: string): Promise<InvestigationState> {
    return this.investigate(userProblem);
  }

  private async executePlan(state: InvestigationState, plan: ActionPlan): Promise<boolean> {
    plan.objective = String(redactSensitiveJson(plan.objective));
    if (plan.rationale !== undefined) plan.rationale = String(redactSensitiveJson(plan.rationale));
    for (const action of plan.actions) {
      state.currentAction = action;
      if (!(await this.executeAction(state, action))) return false;
    }
    return true;
  }

  private async executeAction(state: InvestigationState, action: PlannedAction): Promise<boolean> {
    const input = action.arguments ?? action.input ?? null;
    const recordedInput = redactActionArguments(action, input);
    let tool;
    try {
      tool = this.options.registry.get(action.toolName);
    } catch (error) {
      this.makeActionResult(state, action, false, undefined, error instanceof Error ? error.message : String(error));
      this.recordEvent(state, InvestigationEventType.TOOL_SELECTED, toJsonValue({
        actionId: action.id,
        toolName: action.toolName,
        rejected: true,
        reason: error instanceof Error ? error.message : String(error),
      }));
      this.recordEvent(state, InvestigationEventType.TOOL_RESULT, toJsonValue(state.actionResult));
      return this.fail(state, `Planned tool "${action.toolName}" is not registered.`);
    }

    const validation = validateToolArguments(tool, input);
    if (!validation.valid) {
      this.makeActionResult(state, action, false, undefined, validation.errors.join(' '));
      this.recordEvent(state, InvestigationEventType.TOOL_SELECTED, toJsonValue({
        actionId: action.id,
        toolName: action.toolName,
        arguments: recordedInput,
        rejected: true,
        reason: validation.errors.join(' '),
      }));
      this.recordEvent(state, InvestigationEventType.TOOL_RESULT, toJsonValue(state.actionResult));
      return this.fail(state, `Invalid arguments for tool "${action.toolName}": ${validation.errors.join(' ')}`);
    }

    const policyDecision = await this.permissionPolicy.evaluate(tool.riskLevel, action, state);
    const decision = tool.riskLevel === 'CONSEQUENTIAL' && policyDecision !== PermissionDecision.DENIED
      ? PermissionDecision.REQUIRES_APPROVAL
      : policyDecision;
    action.riskLevel = tool.riskLevel;
    this.recordEvent(state, InvestigationEventType.TOOL_SELECTED, toJsonValue({
      actionId: action.id,
      toolName: action.toolName,
      arguments: recordedInput,
      risk: tool.riskLevel,
    }));
    if (decision === PermissionDecision.DENIED) {
      state.approval = {
        status: ApprovalStatus.REJECTED,
        actionId: action.id,
        toolName: action.toolName,
        riskLevel: tool.riskLevel,
        reason: 'Permission policy denied this action.',
        decidedAt: new Date().toISOString(),
      };
      this.recordEvent(state, InvestigationEventType.APPROVAL_DECIDED, toJsonValue({
        actionId: action.id,
        toolName: action.toolName,
        approved: false,
        reason: state.approval.reason,
      }));
      return this.reject(state, state.approval.reason ?? 'Permission policy denied this action.');
    }

    if (decision === PermissionDecision.REQUIRES_APPROVAL) {
      state.status = InvestigationStatus.AWAITING_APPROVAL;
      state.approval = {
        status: ApprovalStatus.PENDING,
        actionId: action.id,
        toolName: action.toolName,
        riskLevel: tool.riskLevel,
        reason: `Consequential action: ${action.rationale ?? `execute ${action.toolName}`}`,
      };
      this.recordEvent(state, InvestigationEventType.APPROVAL_REQUESTED, toJsonValue({
        actionId: action.id,
        toolName: action.toolName,
        risk: tool.riskLevel,
        reason: state.approval.reason,
      }));
      if (!this.options.approvalProvider) {
        const reason = 'Approval is required but no approval provider is configured.';
        state.approval = {
          ...state.approval,
          status: ApprovalStatus.REJECTED,
          reason,
          decidedAt: new Date().toISOString(),
        };
        this.recordEvent(state, InvestigationEventType.APPROVAL_DECIDED, toJsonValue({
          actionId: action.id,
          toolName: action.toolName,
          approved: false,
          reason,
        }));
        return this.reject(state, reason);
      }
      const decisionResult = await this.options.approvalProvider.requestApproval({
        investigationId: state.id,
        userProblem: state.userProblem,
        action,
        toolName: action.toolName,
        riskLevel: tool.riskLevel,
        reason: state.approval.reason ?? 'Approval required.',
        state,
      });
      const approvalReason = decisionResult.reason ?? state.approval.reason;
      state.approval = {
        ...state.approval,
        status: decisionResult.approved ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED,
        ...(approvalReason !== undefined
          ? { reason: String(redactSensitiveJson(approvalReason)) } : {}),
        decidedAt: new Date().toISOString(),
      };
      this.recordEvent(state, InvestigationEventType.APPROVAL_DECIDED, toJsonValue({
        actionId: action.id,
        toolName: action.toolName,
        approved: decisionResult.approved,
        reason: decisionResult.reason ? String(redactSensitiveJson(decisionResult.reason)) : null,
      }));
      if (!decisionResult.approved) return this.reject(state, decisionResult.reason ?? 'Approval was rejected.');
    } else {
      state.approval = {
        status: ApprovalStatus.NOT_REQUIRED,
        actionId: action.id,
        toolName: action.toolName,
        riskLevel: tool.riskLevel,
        reason: 'Permission policy allowed this action without explicit approval.',
        decidedAt: new Date().toISOString(),
      };
      this.recordEvent(state, InvestigationEventType.APPROVAL_DECIDED, toJsonValue({
        actionId: action.id,
        toolName: action.toolName,
        approved: true,
        approvalRequired: false,
        reason: state.approval.reason,
      }));
    }

    state.status = InvestigationStatus.ACTING;
    const startedAt = new Date().toISOString();
    const context: ToolExecutionContext = {
      investigationId: state.id,
      userProblem: state.userProblem,
      evidence: state.evidence,
      recoveryAttempts: state.recoveryAttempts,
    };
    try {
      const result = await tool.execute(input, context);
      state.actionResult = {
        actionId: action.id,
        toolName: action.toolName,
        success: result.success,
        ...(result.summary !== undefined ? { summary: String(redactSensitiveJson(result.summary)) } : {}),
        ...(result.output !== undefined ? { output: redactSensitiveJson(result.output) } : {}),
        ...(result.data !== undefined ? { data: redactSensitiveJson(result.data) } : {}),
        ...(result.sources !== undefined ? { sources: result.sources.map(redactSourceReference) } : {}),
        ...(result.error !== undefined ? { error: String(redactSensitiveJson(result.error)) } : {}),
        startedAt,
        completedAt: new Date().toISOString(),
      };
      state.actionHistory?.push(state.actionResult);
      if (result.evidence?.length) this.appendEvidence(state, result.evidence.map(redactEvidence));
      this.actionsExecuted.set(state, (this.actionsExecuted.get(state) ?? 0) + 1);
      this.recordEvent(state, InvestigationEventType.TOOL_RESULT, toJsonValue(state.actionResult));
    } catch (error) {
      state.actionResult = this.makeActionResult(
        state,
        action,
        false,
        undefined,
        String(redactSensitiveJson(error instanceof Error ? error.message : String(error))),
        startedAt,
      );
      this.recordEvent(state, InvestigationEventType.TOOL_RESULT, toJsonValue(state.actionResult));
    }
    return true;
  }

  private makeActionResult(
    state: InvestigationState,
    action: PlannedAction,
    success: boolean,
    output?: ActionResult['output'],
    error?: string,
    startedAt = new Date().toISOString(),
  ): ActionResult {
    const result: ActionResult = {
      actionId: action.id,
      toolName: action.toolName,
      success,
      ...(output !== undefined ? { output: redactSensitiveJson(output) } : {}),
      ...(error !== undefined ? { error: String(redactSensitiveJson(error)) } : {}),
      startedAt,
      completedAt: new Date().toISOString(),
    };
    state.actionResult = result;
    state.actionHistory?.push(result);
    return result;
  }

  private appendEvidence(state: InvestigationState, evidence: NonNullable<InvestigationState['evidence']>): void {
    state.evidence.push(...evidence.map(redactEvidence));
  }

  private reject(state: InvestigationState, summary: string): false {
    state.status = InvestigationStatus.REJECTED;
    state.finalResult = this.createFinalResult(state, 'REJECTED', String(redactSensitiveJson(summary)));
    this.recordEvent(state, InvestigationEventType.INVESTIGATION_FAILED, toJsonValue(state.finalResult));
    return false;
  }

  private fail(state: InvestigationState, summary: string): false {
    state.status = InvestigationStatus.FAILED;
    state.finalResult = this.createFinalResult(state, 'FAILED', String(redactSensitiveJson(summary)));
    this.recordEvent(state, InvestigationEventType.INVESTIGATION_FAILED, toJsonValue(state.finalResult));
    return false;
  }

  private async investigateWithAI(state: InvestigationState): Promise<InvestigationState> {
    const aiReasoner = this.options.aiReasoner;
    if (!aiReasoner) return this.failState(state, 'AI reasoner is not configured.');
    let reasoningIterations = 0;
    let toolCalls = 0;
    let recoveryPending = false;
    let verificationRequired = false;

    while (reasoningIterations < this.maxReasoningIterations) {
      state.status = InvestigationStatus.REASONING;
      let reasoning;
      try {
        const rawReasoning = await aiReasoner.analyze(createAIReasonerInput(state, this.options.registry.describe()));
        const validation = validateAIReasoningResult(rawReasoning);
        if (!validation.valid || !validation.result) {
          return this.failState(state, `AI reasoning output failed validation: ${validation.errors.join(' ')}`);
        }
        reasoning = validation.result;
      } catch (error) {
        return this.failState(state, `AI reasoning failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      reasoningIterations += 1;
      state.reasoningSummary = String(redactSensitiveJson(reasoning.reasoningSummary));
      state.recommendedNextStep = reasoning.recommendedAction
        ? String(redactSensitiveJson(reasoning.recommendedAction)) : null;
      const hypothesis = {
        id: `ai-hypothesis-${state.hypotheses.length + 1}`,
        statement: String(redactSensitiveJson(reasoning.hypothesis)),
        rationale: String(redactSensitiveJson(reasoning.reasoningSummary)),
        confidence: reasoning.confidence,
      };
      state.currentHypothesis = hypothesis;
      state.hypotheses.push(hypothesis);
        this.recordEvent(state, InvestigationEventType.REASONING, redactSensitiveJson(toJsonValue({
        decision: reasoning.decision,
        hypothesis: reasoning.hypothesis,
        confidence: reasoning.confidence,
        reasoningSummary: reasoning.reasoningSummary,
        informationNeeded: reasoning.informationNeeded,
        recommendedTool: reasoning.recommendedTool,
        toolArguments: reasoning.toolArguments,
        recommendedAction: reasoning.recommendedAction,
        expectedResult: reasoning.expectedResult,
        proposedRisk: reasoning.risk,
        approvalMayBeRequired: reasoning.approvalMayBeRequired,
        iteration: reasoningIterations,
      })));

      if (reasoning.decision === 'COMPLETE') {
        if (state.verification?.status === VerificationStatus.FAILED) {
          return this.failState(state, 'AI attempted to complete after verification failed.');
        }
        if (verificationRequired && state.verification?.status !== VerificationStatus.PASSED) {
          return this.failState(state, 'AI attempted to complete before a non-read-only action was verified.');
        }
        return this.finish(state, 'SUCCESS', reasoning.reasoningSummary);
      }

      if (reasoning.decision === 'VERIFY') {
        if (toolCalls >= this.maxToolCalls) return this.failState(state, 'Maximum AI tool calls reached before verification.');
        state.status = InvestigationStatus.VERIFYING;
        const verificationAction = await this.options.verifier.createVerificationAction(state);
        if (!verificationAction) return this.failState(state, 'No verification action was produced.');
        state.currentAction = verificationAction;
        toolCalls += 1;
        if (!(await this.executeAction(state, verificationAction))) return state;
        if (!state.actionResult) return this.failState(state, 'Verification produced no action result.');
        state.verification = this.sanitizeVerification(this.options.verifier.evaluate(state, state.actionResult));
        if (state.verification.evidence?.length) this.appendEvidence(state, state.verification.evidence);
        state.observations.push(`Verification ${state.verification.status.toLowerCase()}: ${state.verification.summary}`);
        this.recordEvent(state, InvestigationEventType.VERIFICATION_RESULT, toJsonValue(state.verification));
        if (state.verification.status === VerificationStatus.PASSED) {
          verificationRequired = false;
          return this.finish(state, 'SUCCESS', state.verification.summary);
        }
        if (state.recoveryAttempts >= this.maxRecoveryAttempts) {
          state.recoveryAttempts = this.maxRecoveryAttempts;
          return this.finish(state, 'MAX_RECOVERY_ATTEMPTS', 'Verification failed after the maximum recovery attempts.');
        }
        state.recoveryAttempts += 1;
        state.status = InvestigationStatus.RECOVERING;
        recoveryPending = true;
        this.recordEvent(state, InvestigationEventType.RECOVERY, toJsonValue({
          attempt: state.recoveryAttempts,
          reason: state.verification.summary,
        }));
        continue;
      }

      if (reasoning.decision === 'RECOVER') {
        if (!recoveryPending) {
          if (state.recoveryAttempts >= this.maxRecoveryAttempts) {
            return this.finish(state, 'MAX_RECOVERY_ATTEMPTS', 'AI recovery reached the maximum configured attempts.');
          }
          state.recoveryAttempts += 1;
        }
        recoveryPending = false;
        state.status = InvestigationStatus.RECOVERING;
        this.recordEvent(state, InvestigationEventType.RECOVERY, toJsonValue({
          attempt: state.recoveryAttempts,
          reason: reasoning.reasoningSummary,
        }));
      }

      if (!reasoning.recommendedTool) {
        return this.failState(state, `AI decision ${reasoning.decision} did not include a tool selection.`);
      }
      recoveryPending = false;
      if (reasoning.decision === 'NEED_INFORMATION') {
        try {
          const selectedTool = this.options.registry.get(reasoning.recommendedTool);
          if (selectedTool.riskLevel !== 'READ_ONLY') {
            return this.failState(state, 'NEED_INFORMATION may only select a READ_ONLY tool.');
          }
        } catch {
          // executeAction records and safely rejects unknown tools below.
        }
      }
      if (toolCalls >= this.maxToolCalls) return this.failState(state, 'Maximum AI tool calls reached.');
      const action: PlannedAction = {
        id: `ai-action-${toolCalls + 1}`,
        toolName: reasoning.recommendedTool,
        input: reasoning.toolArguments,
        arguments: reasoning.toolArguments,
        purpose: String(redactSensitiveJson(reasoning.recommendedAction ?? reasoning.reasoningSummary)),
        rationale: String(redactSensitiveJson(reasoning.reasoningSummary)),
        ...(reasoning.expectedResult !== null ? { expectedResult: String(redactSensitiveJson(reasoning.expectedResult)) } : {}),
        ...(reasoning.risk !== null ? { riskLevel: reasoning.risk } : {}),
      };
      state.status = InvestigationStatus.PLANNING;
      state.plan = {
        id: `ai-plan-${reasoningIterations}`,
        objective: String(redactSensitiveJson(reasoning.recommendedAction ?? reasoning.decision)),
        actions: [action],
      };
      toolCalls += 1;
      if (!(await this.executeAction(state, action))) return state;
      if (action.riskLevel && action.riskLevel !== 'READ_ONLY') verificationRequired = true;
    }

    return this.failState(state, 'Maximum AI reasoning iterations reached.');
  }

  private failState(state: InvestigationState, summary: string): InvestigationState {
    this.fail(state, summary);
    return state;
  }

  private finish(state: InvestigationState, outcome: FinalOutcome, summary: string): InvestigationState {
    state.status = outcome === 'SUCCESS' ? InvestigationStatus.COMPLETED : InvestigationStatus.FAILED;
    state.finalResult = this.createFinalResult(state, outcome, String(redactSensitiveJson(summary)));
    this.recordEvent(
      state,
      outcome === 'SUCCESS' ? InvestigationEventType.INVESTIGATION_COMPLETED : InvestigationEventType.INVESTIGATION_FAILED,
      toJsonValue(state.finalResult),
    );
    return state;
  }

  private recordEvent(state: InvestigationState, type: InvestigationEventType, data: import('../types/investigation.js').JsonValue): void {
    const event = recordInvestigationEvent(state, type, data);
    try {
      this.options.onEvent?.(event, state);
    } catch {
      // Observability consumers must never change investigation behavior.
    }
  }

  private createFinalResult(state: InvestigationState, outcome: FinalOutcome, summary: string) {
    return {
      outcome,
      summary: String(redactSensitiveJson(summary)),
      ...(state.currentHypothesis ? { hypothesis: state.currentHypothesis } : {}),
      actionsExecuted: this.actionsExecuted.get(state) ?? 0,
      recoveryAttempts: state.recoveryAttempts,
    };
  }

  private sanitizeVerification(result: VerificationResult): VerificationResult {
    return {
      status: result.status,
      summary: String(redactSensitiveJson(result.summary)),
      ...(result.evidence ? { evidence: result.evidence.map(redactEvidence) } : {}),
      ...(result.details !== undefined ? { details: redactSensitiveJson(result.details) } : {}),
    };
  }
}
