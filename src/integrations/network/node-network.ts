import {
  resolve4,
  resolve6,
  resolveCaa,
  resolveCname,
  resolveMx,
  resolveNs,
  resolveSrv,
  resolveTxt,
} from 'node:dns/promises';
import { connect as connectTls, type DetailedPeerCertificate } from 'node:tls';
import { domainToASCII } from 'node:url';
import { toJsonValue } from '../../types/investigation.js';
import type {
  DnsLookupInput,
  DnsLookupResult,
  DnsRecordType,
  HttpHealthCheckInput,
  HttpHealthResult,
  NetworkDiagnosticsProvider,
  TlsCheckInput,
  TlsCheckResult,
} from './types.js';

export type NetworkErrorCode = 'INVALID_INPUT' | 'TIMEOUT' | 'DNS_ERROR' | 'TLS_ERROR' | 'HTTP_ERROR';

export class NetworkProviderError extends Error {
  constructor(readonly code: NetworkErrorCode, message: string) {
    super(message);
    this.name = 'NetworkProviderError';
  }
}

export interface NodeNetworkProviderOptions {
  fetcher?: typeof fetch;
  dnsResolver?: (hostname: string, recordType: DnsRecordType) => Promise<unknown>;
  tlsInspector?: (input: Required<TlsCheckInput>) => Promise<TlsCheckResult>;
}

const clampTimeout = (value: number | undefined): number =>
  Math.min(30_000, Math.max(100, Number.isFinite(value) ? Math.trunc(value!) : 10_000));

export const sanitizeDiagnosticUrl = (value: string): string => {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[REDACTED]');
  return url.toString();
};

const validateHttpUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NetworkProviderError('INVALID_INPUT', 'HTTP health check requires a valid absolute URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetworkProviderError('INVALID_INPUT', 'HTTP health check supports only http and https URLs.');
  }
  return url;
};

const validateHostname = (value: string): string => {
  const hostname = domainToASCII(value.trim().replace(/\.$/, ''));
  if (!hostname || hostname.length > 253 || hostname.includes('/') || hostname.includes(':')) {
    throw new NetworkProviderError('INVALID_INPUT', 'A valid hostname is required.');
  }
  return hostname;
};

const usefulHeaders = (headers: Headers): Record<string, string> => {
  const allowed = ['cache-control', 'content-type', 'location', 'retry-after', 'server', 'x-vercel-id', 'cf-ray'];
  return Object.fromEntries(allowed.flatMap((name) => {
    const value = headers.get(name);
    return value ? [[name, value] as const] : [];
  }));
};

const fetchWithTimeout = async (fetcher: typeof fetch, url: URL, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetcher(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: '*/*', 'user-agent': 'BIMO-Operations-Agent/0.1' },
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new NetworkProviderError('TIMEOUT', `HTTP request timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof NetworkProviderError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/abort|timeout/i.test(message)) throw new NetworkProviderError('TIMEOUT', `HTTP request timed out after ${timeoutMs}ms.`);
    throw new NetworkProviderError('HTTP_ERROR', `HTTP request failed: ${message.slice(0, 500)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const defaultDnsResolver = async (hostname: string, recordType: DnsRecordType): Promise<unknown> => {
  switch (recordType) {
    case 'A': return resolve4(hostname);
    case 'AAAA': return resolve6(hostname);
    case 'CNAME': return resolveCname(hostname);
    case 'MX': return resolveMx(hostname);
    case 'TXT': return resolveTxt(hostname);
    case 'NS': return resolveNs(hostname);
    case 'CAA': return resolveCaa(hostname);
    case 'SRV': return resolveSrv(hostname);
  }
};

const stringRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
};

const inspectTls = (input: Required<TlsCheckInput>): Promise<TlsCheckResult> => new Promise((resolve, reject) => {
  const socket = connectTls({
    host: input.hostname,
    port: input.port,
    servername: input.hostname,
    rejectUnauthorized: true,
  });
  const timer = setTimeout(() => {
    socket.destroy();
    reject(new NetworkProviderError('TIMEOUT', `TLS connection timed out after ${input.timeoutMs}ms.`));
  }, input.timeoutMs);
  const finish = () => clearTimeout(timer);
  socket.once('error', (error) => {
    finish();
    reject(new NetworkProviderError('TLS_ERROR', `TLS connection failed: ${error.message.slice(0, 500)}`));
  });
  socket.once('secureConnect', () => {
    finish();
    const certificate = socket.getPeerCertificate(true) as DetailedPeerCertificate;
    const cipher = socket.getCipher();
    const validTo = certificate.valid_to ? new Date(certificate.valid_to) : null;
    const daysRemaining = validTo && !Number.isNaN(validTo.getTime())
      ? Math.floor((validTo.getTime() - Date.now()) / 86_400_000)
      : null;
    const result: TlsCheckResult = {
      hostname: input.hostname,
      port: input.port,
      authorized: socket.authorized,
      protocol: socket.getProtocol(),
      cipher: cipher?.name ?? null,
      subject: stringRecord(certificate.subject),
      issuer: stringRecord(certificate.issuer),
      validFrom: certificate.valid_from ?? null,
      validTo: certificate.valid_to ?? null,
      daysRemaining,
      fingerprint256: certificate.fingerprint256 ?? null,
      serialNumber: certificate.serialNumber ?? null,
      subjectAltName: certificate.subjectaltname?.slice(0, 2000) ?? null,
    };
    socket.end();
    resolve(result);
  });
});

export class NodeNetworkProvider implements NetworkDiagnosticsProvider {
  private readonly fetcher: typeof fetch;
  private readonly dnsResolver: (hostname: string, recordType: DnsRecordType) => Promise<unknown>;
  private readonly tlsInspector: (input: Required<TlsCheckInput>) => Promise<TlsCheckResult>;

  constructor(options: NodeNetworkProviderOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.dnsResolver = options.dnsResolver ?? defaultDnsResolver;
    this.tlsInspector = options.tlsInspector ?? inspectTls;
  }

  async httpHealthCheck(input: HttpHealthCheckInput): Promise<HttpHealthResult> {
    const startedAt = Date.now();
    const timeoutMs = clampTimeout(input.timeoutMs);
    let current = validateHttpUrl(input.url);
    const initialUrl = sanitizeDiagnosticUrl(current.toString());
    const redirects: string[] = [];

    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      const elapsed = Date.now() - startedAt;
      const response = await fetchWithTimeout(this.fetcher, current, Math.max(100, timeoutMs - elapsed));
      const location = response.headers.get('location');
      if (location && response.status >= 300 && response.status < 400) {
        if (redirectCount === 5) {
          await response.body?.cancel();
          throw new NetworkProviderError('HTTP_ERROR', 'HTTP health check exceeded five redirects.');
        }
        current = new URL(location, current);
        redirects.push(sanitizeDiagnosticUrl(current.toString()));
        await response.body?.cancel();
        continue;
      }
      const result: HttpHealthResult = {
        ok: response.ok,
        url: initialUrl,
        finalUrl: sanitizeDiagnosticUrl(current.toString()),
        statusCode: response.status,
        responseTimeMs: Date.now() - startedAt,
        redirects,
        headers: usefulHeaders(response.headers),
      };
      await response.body?.cancel();
      return result;
    }
    throw new NetworkProviderError('HTTP_ERROR', 'HTTP health check ended without a response.');
  }

  async dnsLookup(input: DnsLookupInput): Promise<DnsLookupResult> {
    const hostname = validateHostname(input.hostname);
    try {
      const result = await this.dnsResolver(hostname, input.recordType);
      const value = toJsonValue(result);
      return {
        hostname,
        recordType: input.recordType,
        records: Array.isArray(value) ? value : [value],
      };
    } catch (error) {
      if (error instanceof NetworkProviderError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new NetworkProviderError('DNS_ERROR', `DNS ${input.recordType} lookup failed: ${message.slice(0, 500)}`);
    }
  }

  tlsCheck(input: TlsCheckInput): Promise<TlsCheckResult> {
    const hostname = validateHostname(input.hostname);
    const port = input.port ?? 443;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new NetworkProviderError('INVALID_INPUT', 'TLS port must be an integer between 1 and 65535.');
    }
    return this.tlsInspector({ hostname, port, timeoutMs: clampTimeout(input.timeoutMs) });
  }
}

export const createNodeNetworkProvider = (options: NodeNetworkProviderOptions = {}) => new NodeNetworkProvider(options);
