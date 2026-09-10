import {
  InvestigationEventType,
  type InvestigationEvent,
  type InvestigationState,
  type JsonValue,
} from '../types/investigation.js';
import { redactSensitiveJson } from '../safety/redaction.js';

export const recordInvestigationEvent = (
  state: InvestigationState,
  type: InvestigationEventType,
  data: JsonValue,
): InvestigationEvent => {
  const event: InvestigationEvent = {
    id: `${state.id}-event-${(state.events?.length ?? 0) + 1}`,
    investigationId: state.id,
    type,
    timestamp: new Date().toISOString(),
    data: redactSensitiveJson(data),
  };
  state.events?.push(event);
  return event;
};
