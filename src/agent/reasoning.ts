import type { Evidence, Hypothesis, InvestigationState } from '../types/investigation.js';

export interface ReasoningResult {
  observation?: string;
  evidence?: Evidence[];
  hypothesis: Hypothesis;
  reasoningSummary?: string;
  recommendedNextStep?: string;
}

export interface Reasoner {
  analyze(state: InvestigationState): ReasoningResult | Promise<ReasoningResult>;
}

const stringifyEvidence = (evidence: Evidence[]): string =>
  evidence.map((item) => `${item.summary} ${JSON.stringify(item.details ?? '')}`).join(' ');

export class BasicReasoner implements Reasoner {
  analyze(state: InvestigationState): ReasoningResult {
  const context = `${state.userProblem} ${stringifyEvidence(state.evidence)} ${state.actionHistory?.map((item) => item.error ?? item.summary ?? '').join(' ') ?? ''}`.toLowerCase();
    const dependencyIssue = /dependenc|module resolution|build|package/.test(context);
    const statement = dependencyIssue
      ? 'A dependency or build-resolution problem is preventing the requested operation.'
      : 'The reported problem requires more diagnostic evidence before a specific cause can be confirmed.';

    return {
      observation: state.evidence.length
        ? `Reviewed ${state.evidence.length} piece(s) of evidence.`
        : 'No diagnostic evidence has been collected yet.',
      reasoningSummary: dependencyIssue
        ? 'The evidence points toward a dependency or build-resolution failure.'
        : 'The available evidence does not yet isolate a specific failure mode.',
      recommendedNextStep: dependencyIssue ? 'Inspect dependency documentation and apply a registered remediation.' : 'Collect targeted external documentation or logs.',
      hypothesis: {
        id: `hypothesis-${state.hypotheses.length + 1}`,
        statement,
        rationale: dependencyIssue
          ? 'The available evidence contains dependency or build-related signals.'
          : 'The current evidence does not identify a specific failure mode.',
        confidence: dependencyIssue ? 0.8 : 0.35,
      },
    };
  }
}
