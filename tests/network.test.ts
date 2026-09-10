import { describe, expect, it, vi } from 'vitest';
import {
  DnsLookupTool,
  HttpHealthCheckTool,
  NetworkProviderError,
  NodeNetworkProvider,
  TlsCheckTool,
  type TlsCheckResult,
} from '../src/index.js';

const context = {
  investigationId: 'investigation-network',
  userProblem: 'API is unreachable',
  evidence: [],
  recoveryAttempts: 0,
};

const tlsResult: TlsCheckResult = {
  hostname: 'api.example.com',
  port: 443,
  authorized: true,
  protocol: 'TLSv1.3',
  cipher: 'TLS_AES_256_GCM_SHA384',
  subject: { CN: 'api.example.com' },
  issuer: { CN: 'Test CA' },
  validFrom: 'Jan 1 00:00:00 2026 GMT',
  validTo: 'Jan 1 00:00:00 2027 GMT',
  daysRemaining: 100,
  fingerprint256: 'AA:BB',
  serialNumber: '123',
  subjectAltName: 'DNS:api.example.com',
};

describe('provider-independent network diagnostics', () => {
  it('returns HTTP status, latency, headers, and redacted redirect information', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://api.example.com/health?token=secret' } }))
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'content-type': 'application/json', server: 'test' } }));
    const provider = new NodeNetworkProvider({ fetcher });
    const tool = new HttpHealthCheckTool(provider);

    const result = await tool.execute({ url: 'http://api.example.com/start?key=secret' }, context);

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ ok: true, statusCode: 200, headers: { 'content-type': 'application/json' } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('converts HTTP connection failure into a structured tool failure', async () => {
    const provider = new NodeNetworkProvider({ fetcher: vi.fn(async () => { throw new Error('connection refused'); }) });
    const result = await new HttpHealthCheckTool(provider).execute({ url: 'https://api.example.com' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('connection refused');
  });

  it('enforces HTTP timeouts', async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const provider = new NodeNetworkProvider({ fetcher });

    const result = await new HttpHealthCheckTool(provider).execute({ url: 'https://api.example.com', timeoutMs: 100 }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('returns structured DNS records', async () => {
    const dnsResolver = vi.fn(async () => ['203.0.113.10', '203.0.113.11']);
    const provider = new NodeNetworkProvider({ dnsResolver });
    const result = await new DnsLookupTool(provider).execute({ hostname: 'api.example.com', recordType: 'A' }, context);

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ recordType: 'A', records: ['203.0.113.10', '203.0.113.11'] });
  });

  it('converts resolver errors into DNS tool failures', async () => {
    const provider = new NodeNetworkProvider({ dnsResolver: vi.fn(async () => { throw new Error('ENOTFOUND'); }) });
    const result = await new DnsLookupTool(provider).execute({ hostname: 'missing.example', recordType: 'A' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('ENOTFOUND');
  });

  it('returns verified TLS certificate information and preserves TLS failures', async () => {
    const provider = new NodeNetworkProvider({ tlsInspector: vi.fn(async () => tlsResult) });
    const success = await new TlsCheckTool(provider).execute({ hostname: 'api.example.com' }, context);
    expect(success.success).toBe(true);
    expect(success.output).toMatchObject({ authorized: true, protocol: 'TLSv1.3' });

    const failing = new NodeNetworkProvider({
      tlsInspector: vi.fn(async () => { throw new NetworkProviderError('TLS_ERROR', 'certificate expired'); }),
    });
    const failure = await new TlsCheckTool(failing).execute({ hostname: 'api.example.com' }, context);
    expect(failure.success).toBe(false);
    expect(failure.error).toContain('certificate expired');
  });
});
