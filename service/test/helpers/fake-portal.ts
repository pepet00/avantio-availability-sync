// Portal falso para los tests: un servidor HTTP que responde lo que el test le indica
// y registra cada petición con su hora. El portal real falla y tarda al azar; este no.

import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { now } from '../../src/clock.js';

/** Respuesta con código. Sin `json` ni `text`, el cuerpo imita al portal (`200` o `{ error }`). */
export interface FakeReply {
  status: number;
  json?: unknown;
  /** Cuerpo en texto plano (por ejemplo, una página HTML de un proxy). */
  text?: string;
  headers?: Record<string, string>;
}

/** No responde nunca: la petición queda abierta hasta que el cliente la corte o se reinicie el portal. */
export const NO_RESPONSE = 'no-response';

export type FakeResponse = FakeReply | typeof NO_RESPONSE;

/** Decide la respuesta de una petición; puede esperar (por ejemplo, para retener un `200`). */
export type Responder = (request: RecordedRequest) => FakeResponse | Promise<FakeResponse>;

export interface RecordedRequest {
  method: string;
  /** Ruta tal como llegó, sin decodificar. */
  path: string;
  /** Id decodificado si la ruta es la del PUT de disponibilidad. */
  accommodationId: string | null;
  headers: IncomingHttpHeaders;
  /** Cuerpo parseado como JSON, o el texto si no lo es. */
  body: unknown;
  /** Instante de llegada según el reloj del servicio (desplazable en tests). */
  at: Date;
  /** Llegada medida con `performance.now()`, para comparar duraciones. */
  receivedAtMs: number;
  /** Código respondido; `null` mientras no se responde (o si nunca se responde). */
  status: number | null;
}

export interface FakePortal {
  url: string;
  /** Peticiones recibidas, en orden de llegada. */
  readonly requests: readonly RecordedRequest[];
  /** Encola respuestas: cada petición consume la primera; con la cola vacía, se usa la de por defecto. */
  enqueue(...responses: (FakeResponse | Responder)[]): void;
  /** Respuesta cuando la cola está vacía. Al empezar y tras `reset`, `200`. */
  setDefault(response: FakeResponse | Responder): void;
  /** Vacía registro y cola, vuelve a la respuesta por defecto y corta las peticiones abiertas. */
  reset(): void;
  close(): Promise<void>;
}

const AVAILABILITY_PATH = /^\/api\/v1\/accommodations\/([^/?]+)\/availability(?:\?|$)/;

const ERROR_CODES: Record<number, string> = {
  400: 'INVALID_BODY',
  401: 'UNAUTHORIZED',
  404: 'NOT_FOUND',
  429: 'RATE_LIMITED',
  503: 'UNAVAILABLE',
};

export const ok = (): FakeReply => ({ status: 200 });
export const rateLimited = (retryAfterSeconds?: number): FakeReply =>
  retryAfterSeconds === undefined
    ? { status: 429 }
    : { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } };

export async function startFakePortal(): Promise<FakePortal> {
  const requests: RecordedRequest[] = [];
  const queue: (FakeResponse | Responder)[] = [];
  let fallback: FakeResponse | Responder = ok();
  const open = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    const receivedAtMs = performance.now();
    const at = now();
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const path = req.url ?? '';
      const match = AVAILABILITY_PATH.exec(path);
      const encodedId = match?.[1];
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        path,
        accommodationId: encodedId === undefined ? null : decodeURIComponent(encodedId),
        headers: req.headers,
        body: parseBody(raw),
        at,
        receivedAtMs,
        status: null,
      };
      requests.push(recorded);

      const next = queue.shift() ?? fallback;
      open.add(res);
      res.on('close', () => open.delete(res));
      void Promise.resolve(typeof next === 'function' ? next(recorded) : next).then((response) => {
        if (response === NO_RESPONSE || res.destroyed) return;
        recorded.status = response.status;
        send(res, response, recorded);
      });
    });
  });

  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;

  function dropOpen(): void {
    for (const res of open) res.destroy();
    open.clear();
  }

  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    enqueue: (...responses) => queue.push(...responses),
    setDefault: (response) => {
      fallback = response;
    },
    reset: () => {
      requests.length = 0;
      queue.length = 0;
      fallback = ok();
      dropOpen();
    },
    close: async () => {
      dropOpen();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

function parseBody(raw: string): unknown {
  if (raw === '') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function send(res: ServerResponse, reply: FakeReply, request: RecordedRequest): void {
  let body: string;
  let contentType: string;
  if (reply.text !== undefined) {
    body = reply.text;
    contentType = 'text/html; charset=utf-8';
  } else {
    body = JSON.stringify(reply.json ?? defaultJson(reply.status, request));
    contentType = 'application/json';
  }
  res.writeHead(reply.status, { 'Content-Type': contentType, ...reply.headers });
  res.end(body);
}

function defaultJson(status: number, request: RecordedRequest): unknown {
  if (status >= 200 && status < 300) {
    const body = request.body as { from?: unknown; to?: unknown } | null;
    return { accommodationId: request.accommodationId, from: body?.from, to: body?.to, daysUpdated: 1 };
  }
  const code = ERROR_CODES[status] ?? 'ERROR';
  return { error: { code, message: `Respuesta ${String(status)} del portal falso` } };
}
