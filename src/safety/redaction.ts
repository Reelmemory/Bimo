import type { Evidence, JsonValue, PlannedAction, SourceReference } from '../types/investigation.js';

const sensitiveKey = /(?:^|[_-])(authorization|cookie|credential|password|private[_-]?key|secret|token|api[_-]?key|rpc[_-]?url)(?:$|[_-])/i;
const sensitiveQueryKey = /token|key|secret|signature|credential|password|authorization|auth/i;

const isSensitiveKey = (key: string): boolean =>
  sensitiveKey.test(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2'));

const redactString = (value: string): string => {
  let redacted = value
    .replace(/bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/(\b(?:[A-Z][A-Z0-9]*_)*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|RPC[_-]?URL))\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]');
  if (/^https?:\/\//i.test(redacted)) {
    try {
      const url = new URL(redacted);
      if (url.username) url.username = '[REDACTED]';
      if (url.password) url.password = '[REDACTED]';
      for (const key of [...url.searchParams.keys()]) {
        if (sensitiveQueryKey.test(key)) url.searchParams.set(key, '[REDACTED]');
      }
      redacted = url.toString();
    } catch {
      // Leave malformed strings to normal argument validation.
    }
  }
  return redacted;
};

export const redactSensitiveJson = (value: JsonValue, key?: string): JsonValue => {
  if (key && isSensitiveKey(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveJson(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactSensitiveJson(item, name)]));
  }
  return value;
};

export const redactActionArguments = (action: PlannedAction, input: JsonValue): JsonValue => {
  const redacted = redactSensitiveJson(input);
  if (action.input !== undefined) action.input = redacted;
  if (action.arguments !== undefined) action.arguments = redacted;
  if (action.purpose !== undefined) action.purpose = String(redactSensitiveJson(action.purpose));
  if (action.expectedResult !== undefined) action.expectedResult = String(redactSensitiveJson(action.expectedResult));
  if (action.rationale !== undefined) action.rationale = String(redactSensitiveJson(action.rationale));
  return redacted;
};

export const redactSourceReference = (source: SourceReference): SourceReference => ({
  ...source,
  url: String(redactSensitiveJson(source.url)),
  ...(source.title !== undefined ? { title: String(redactSensitiveJson(source.title)) } : {}),
  ...(source.snippet !== undefined ? { snippet: String(redactSensitiveJson(source.snippet)) } : {}),
});

export const redactEvidence = (evidence: Evidence): Evidence => ({
  ...evidence,
  summary: String(redactSensitiveJson(evidence.summary)),
  ...(evidence.content !== undefined ? { content: String(redactSensitiveJson(evidence.content)) } : {}),
  ...(evidence.details !== undefined ? { details: redactSensitiveJson(evidence.details) } : {}),
  ...(evidence.url !== undefined ? { url: String(redactSensitiveJson(evidence.url)) } : {}),
  ...(evidence.reference !== undefined ? { reference: String(redactSensitiveJson(evidence.reference)) } : {}),
  ...(evidence.references !== undefined ? { references: evidence.references.map(redactSourceReference) } : {}),
});
