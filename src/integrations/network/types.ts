import type { JsonValue } from '../../types/investigation.js';

export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'CAA' | 'SRV';

export interface HttpHealthCheckInput {
  url: string;
  timeoutMs?: number;
}

export interface HttpHealthResult {
  [key: string]: JsonValue;
  ok: boolean;
  url: string;
  finalUrl: string;
  statusCode: number;
  responseTimeMs: number;
  redirects: string[];
  headers: { [key: string]: string };
}

export interface DnsLookupInput {
  hostname: string;
  recordType: DnsRecordType;
}

export interface DnsLookupResult {
  [key: string]: JsonValue;
  hostname: string;
  recordType: DnsRecordType;
  records: JsonValue[];
}

export interface TlsCheckInput {
  hostname: string;
  port?: number;
  timeoutMs?: number;
}

export interface TlsCheckResult {
  [key: string]: JsonValue;
  hostname: string;
  port: number;
  authorized: boolean;
  protocol: string | null;
  cipher: string | null;
  subject: { [key: string]: string };
  issuer: { [key: string]: string };
  validFrom: string | null;
  validTo: string | null;
  daysRemaining: number | null;
  fingerprint256: string | null;
  serialNumber: string | null;
  subjectAltName: string | null;
}

export interface NetworkDiagnosticsProvider {
  httpHealthCheck(input: HttpHealthCheckInput): Promise<HttpHealthResult>;
  dnsLookup(input: DnsLookupInput): Promise<DnsLookupResult>;
  tlsCheck(input: TlsCheckInput): Promise<TlsCheckResult>;
}
