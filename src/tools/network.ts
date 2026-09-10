import { EvidenceSource, EvidenceType, type Evidence, type JsonValue } from '../types/investigation.js';
import type {
  DnsLookupInput,
  HttpHealthCheckInput,
  NetworkDiagnosticsProvider,
  TlsCheckInput,
} from '../integrations/network/types.js';
import { NetworkProviderError } from '../integrations/network/node-network.js';
import { RiskLevel, type Tool, type ToolExecutionContext } from './types.js';

const errorDetails = (error: unknown): { code: string; message: string } => ({
  code: error instanceof NetworkProviderError ? error.code : 'NETWORK_ERROR',
  message: (error instanceof Error ? error.message : String(error)).slice(0, 800),
});

const networkEvidence = (
  context: ToolExecutionContext,
  type: EvidenceType,
  summary: string,
  details: JsonValue,
  confidence: number,
  reference?: string,
): Evidence => ({
  id: `${context.investigationId}-network-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  source: EvidenceSource.NETWORK,
  type,
  summary,
  details,
  confidence,
  ...(reference ? { reference } : {}),
  timestamp: new Date().toISOString(),
});

export class HttpHealthCheckTool implements Tool<HttpHealthCheckInput, JsonValue> {
  readonly name = 'http_health_check';
  readonly description = 'Checks HTTP reachability, status, latency, redirects, and diagnostic response headers without returning the response body.';
  readonly riskLevel = RiskLevel.READ_ONLY;
  readonly inputDefinition = {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'Absolute http or https URL to check.' },
      timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds, capped at 30000.' },
    },
    required: ['url'],
  };

  constructor(private readonly provider: NetworkDiagnosticsProvider) {}

  async execute(input: HttpHealthCheckInput, context: ToolExecutionContext) {
    try {
      const result = await this.provider.httpHealthCheck(input);
      const summary = result.ok
        ? `HTTP health check passed with status ${result.statusCode} in ${result.responseTimeMs}ms.`
        : `HTTP endpoint responded with unhealthy status ${result.statusCode} in ${result.responseTimeMs}ms.`;
      return {
        success: true,
        summary,
        output: result,
        data: result,
        evidence: [networkEvidence(context, EvidenceType.HTTP, summary, result, result.ok ? 0.95 : 0.9, result.finalUrl)],
        sources: [{ url: result.finalUrl, title: 'HTTP health check target', retrievedAt: new Date().toISOString() }],
      };
    } catch (error) {
      const failure = errorDetails(error);
      const evidence = networkEvidence(context, EvidenceType.HTTP, failure.message, failure, 0.95);
      return { success: false, summary: 'HTTP health check could not reach the target.', error: failure.message, data: failure, evidence: [evidence] };
    }
  }
}

export class DnsLookupTool implements Tool<DnsLookupInput, JsonValue> {
  readonly name = 'dns_lookup';
  readonly description = 'Resolves DNS records for a hostname using a selected record type.';
  readonly riskLevel = RiskLevel.READ_ONLY;
  readonly inputDefinition = {
    type: 'object' as const,
    properties: {
      hostname: { type: 'string', description: 'Hostname without a URL scheme or path.' },
      recordType: { type: 'string', enum: ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'CAA', 'SRV'] },
    },
    required: ['hostname', 'recordType'],
  };

  constructor(private readonly provider: NetworkDiagnosticsProvider) {}

  async execute(input: DnsLookupInput, context: ToolExecutionContext) {
    try {
      const result = await this.provider.dnsLookup(input);
      const summary = `DNS ${result.recordType} lookup returned ${result.records.length} record(s) for ${result.hostname}.`;
      return {
        success: true,
        summary,
        output: result,
        data: result,
        evidence: [networkEvidence(context, EvidenceType.DNS, summary, result, 0.95, `dns:${result.hostname}/${result.recordType}`)],
      };
    } catch (error) {
      const failure = errorDetails(error);
      return {
        success: false,
        summary: 'DNS lookup failed.',
        error: failure.message,
        data: failure,
        evidence: [networkEvidence(context, EvidenceType.DNS, failure.message, failure, 0.95)],
      };
    }
  }
}

export class TlsCheckTool implements Tool<TlsCheckInput, JsonValue> {
  readonly name = 'tls_check';
  readonly description = 'Checks a host TLS handshake and returns verified certificate, protocol, cipher, and expiry information.';
  readonly riskLevel = RiskLevel.READ_ONLY;
  readonly inputDefinition = {
    type: 'object' as const,
    properties: {
      hostname: { type: 'string', description: 'TLS server hostname without scheme or path.' },
      port: { type: 'integer', description: 'TLS port; defaults to 443.' },
      timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds, capped at 30000.' },
    },
    required: ['hostname'],
  };

  constructor(private readonly provider: NetworkDiagnosticsProvider) {}

  async execute(input: TlsCheckInput, context: ToolExecutionContext) {
    try {
      const result = await this.provider.tlsCheck(input);
      const summary = result.authorized
        ? `TLS verification passed using ${result.protocol ?? 'an unknown protocol'}; certificate expires in ${result.daysRemaining ?? 'an unknown number of'} days.`
        : 'TLS connected but certificate authorization was not confirmed.';
      return {
        success: true,
        summary,
        output: result,
        data: result,
        evidence: [networkEvidence(context, EvidenceType.TLS, summary, result, result.authorized ? 0.98 : 0.8, `tls://${result.hostname}:${result.port}`)],
      };
    } catch (error) {
      const failure = errorDetails(error);
      return {
        success: false,
        summary: 'TLS check failed.',
        error: failure.message,
        data: failure,
        evidence: [networkEvidence(context, EvidenceType.TLS, failure.message, failure, 0.95)],
      };
    }
  }
}

export const createNetworkTools = (provider: NetworkDiagnosticsProvider) => [
  new HttpHealthCheckTool(provider),
  new DnsLookupTool(provider),
  new TlsCheckTool(provider),
];
