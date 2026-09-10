import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createDemoRuntimeFactory } from '../src/application/demo.js';
import { BimoApplicationService } from '../src/application/service.js';

const port = Number(process.env.BIMO_INTERFACE_PORT ?? 8787);
const service = new BimoApplicationService(createDemoRuntimeFactory({ failFirstFix: true }));

const json = (response: ServerResponse, status: number, value: unknown): void => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(value));
};

const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 100_000) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Request body must be a JSON object.');
  return parsed as Record<string, unknown>;
};

const investigationIdFromPath = (pathname: string): string | null => {
  const match = pathname.match(/^\/api\/investigations\/([^/]+)(?:\/([^/]+))?$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
};

const server = createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'content-type');
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    response.end();
    return;
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname === '/api/health' && request.method === 'GET') {
    json(response, 200, { ok: true, service: 'bimo-interface' });
    return;
  }

  if (url.pathname === '/api/investigations' && request.method === 'POST') {
    try {
      const body = await readJson(request);
      if (typeof body.problem !== 'string' || !body.problem.trim()) {
        json(response, 400, { error: 'problem must be a non-empty string.' });
        return;
      }
      const started = service.start(body.problem);
      json(response, 202, started);
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  const investigationId = investigationIdFromPath(url.pathname);
  if (!investigationId) {
    json(response, 404, { error: 'Route not found.' });
    return;
  }

  if (request.method === 'GET' && url.pathname.endsWith('/events')) {
    const snapshot = service.get(investigationId);
    if (!snapshot) {
      json(response, 404, { error: 'Investigation not found.' });
      return;
    }
    response.statusCode = 200;
    response.setHeader('content-type', 'text/event-stream; charset=utf-8');
    response.setHeader('cache-control', 'no-cache, no-transform');
    response.setHeader('connection', 'keep-alive');
    response.flushHeaders();
    const send = (event: string, data: unknown) => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = service.subscribe(investigationId, (update) => send('update', update));
      send('snapshot', snapshot);
    } catch (error) {
      send('error', { error: error instanceof Error ? error.message : String(error) });
      response.end();
      return;
    }
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15_000);
    request.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe?.();
      response.end();
    });
    return;
  }

  if (request.method === 'GET') {
    const snapshot = service.get(investigationId);
    if (!snapshot) {
      json(response, 404, { error: 'Investigation not found.' });
      return;
    }
    json(response, 200, snapshot);
    return;
  }

  if (request.method === 'POST' && url.pathname.endsWith('/approval')) {
    try {
      const body = await readJson(request);
      if (typeof body.approved !== 'boolean') {
        json(response, 400, { error: 'approved must be a boolean.' });
        return;
      }
      const accepted = service.decideApproval(
        investigationId,
        body.approved,
        typeof body.reason === 'string' ? body.reason : undefined,
      );
      if (!accepted) {
        json(response, 409, { error: 'No pending approval exists for this investigation.' });
        return;
      }
      json(response, 202, { accepted: true });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  json(response, 404, { error: 'Route not found.' });
});

server.listen(port, () => {
  console.log(`BIMO interface API listening on http://localhost:${port}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
