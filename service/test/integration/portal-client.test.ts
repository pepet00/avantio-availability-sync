import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { advanceClock, now, resetClock } from '../../src/clock.js';
import { addDays, todayUtc } from '../../src/dates.js';
import { createMetrics } from '../../src/metrics/registry.js';
import { PortalClient, type PortalClientConfig, type PortalOutcome, type PortalRange } from '../../src/portal/client.js';
import { captureLogs, type LogCapture } from '../helpers/log-capture.js';
import {
  NO_RESPONSE,
  ok,
  rateLimited,
  startFakePortal,
  type FakePortal,
  type FakeReply,
} from '../helpers/fake-portal.js';

const DAY_MS = 86_400_000;

// La ventana se garantiza sobre la hora de envío; el portal falso mide la de llegada, que añade
// la latencia local de cada petición (unos pocos ms, distinta en cada una).
const LATENCY_TOLERANCE_MS = 30;

let portal: FakePortal;
let logs: LogCapture;
let range: PortalRange;

/** Rango de `days` días que empieza `offset` días después de hoy, según el reloj controlado. */
function rangeFromToday(days: number, offset = 1): PortalRange {
  const from = addDays(todayUtc(now()), offset);
  return { from, to: addDays(from, days - 1), available: false, pricePerNight: 120.5 };
}

interface ClientOptions extends Partial<PortalClientConfig> {
  windowMs?: number;
  defaultRetryAfterMs?: number;
}

function createClient({ windowMs, defaultRetryAfterMs, ...config }: ClientOptions = {}): PortalClient {
  return new PortalClient(
    { portalUrl: portal.url, portalApiKey: 'test-key', portalRateLimit: 100, portalTimeoutMs: 2_000, ...config },
    { logger: logs.logger, metrics: createMetrics(), windowMs: windowMs ?? 60_000, defaultRetryAfterMs: defaultRetryAfterMs ?? 60_000 },
  );
}

function arrivalsAfter(index: number): number[] {
  const first = portal.requests[index];
  if (first === undefined) throw new Error(`No hay petición ${String(index)}`);
  return portal.requests.slice(index + 1).map((r) => r.receivedAtMs - first.receivedAtMs);
}

beforeAll(async () => {
  portal = await startFakePortal();
});

afterAll(async () => {
  await portal.close();
});

beforeEach(() => {
  portal.reset();
  logs = captureLogs();
  range = rangeFromToday(7);
});

afterEach(() => {
  resetClock();
});

describe('PUT al portal', () => {
  it('lleva X-Api-Key, el cuerpo del rango y el id codificado con encodeURIComponent', async () => {
    const id = 'acc 1/ñ?#&';

    const result = await createClient().put(id, range);

    expect(result.outcome).toBe('success');
    expect(portal.requests).toHaveLength(1);
    const [request] = portal.requests;
    expect(request?.method).toBe('PUT');
    expect(request?.path).toBe(`/api/v1/accommodations/${encodeURIComponent(id)}/availability`);
    expect(request?.accommodationId).toBe(id);
    expect(request?.headers['x-api-key']).toBe('test-key');
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.body).toStrictEqual(range);
  });

  it('no pierde la ruta base de PORTAL_URL', async () => {
    await createClient({ portalUrl: `${portal.url}/base/` }).put('acc-1', range);

    expect(portal.requests[0]?.path).toBe('/base/api/v1/accommodations/acc-1/availability');
  });

  it.each<[string, FakeReply, PortalOutcome]>([
    ['200', ok(), 'success'],
    ['202 (otro 2xx)', { status: 202, json: {} }, 'success'],
    ['503', { status: 503 }, 'unavailable'],
    ['500', { status: 500 }, 'server_error'],
    ['502', { status: 502 }, 'server_error'],
    ['302 (no se sigue la redirección)', { status: 302, json: {}, headers: { Location: '/otro' } }, 'server_error'],
    ['200 con cuerpo que no es JSON', { status: 200, text: '<html>ok</html>' }, 'server_error'],
    ['200 sin cuerpo', { status: 200, text: '' }, 'server_error'],
    ['503 con cuerpo que no es JSON', { status: 503, text: '<html>Service Unavailable</html>' }, 'server_error'],
    ['404 con cuerpo que no es JSON', { status: 404, text: 'Not Found' }, 'server_error'],
    ['401', { status: 401 }, 'unauthorized'],
    ['404', { status: 404 }, 'not_found'],
    ['400', { status: 400 }, 'bad_request'],
    ['409 (otro 4xx)', { status: 409 }, 'bad_request'],
    ['422 (otro 4xx)', { status: 422 }, 'bad_request'],
    ['429', rateLimited(0), 'rate_limited'],
    ['429 con cuerpo que no es JSON', { status: 429, text: 'Too Many', headers: { 'Retry-After': '0' } }, 'rate_limited'],
  ])('%s → %s', async (_name, reply, outcome) => {
    portal.enqueue(reply);

    const result = await createClient().put('acc-1', range);

    expect(result.outcome).toBe(outcome);
    expect(result.status).toBe(reply.status);
  });

  it('un error del portal conserva su código y su mensaje', async () => {
    portal.enqueue({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Accommodation acc-9 not found' } } });

    const result = await createClient().put('acc-9', range);

    expect(result).toMatchObject({
      outcome: 'not_found',
      status: 404,
      error: { code: 'NOT_FOUND', message: 'Accommodation acc-9 not found' },
    });
  });

  it('sin respuesta da timeout al cumplirse PORTAL_TIMEOUT_MS', async () => {
    portal.enqueue(NO_RESPONSE);
    const started = performance.now();

    const result = await createClient({ portalTimeoutMs: 200 }).put('acc-1', range);

    const elapsed = performance.now() - started;
    expect(result).toMatchObject({ outcome: 'timeout', status: null, error: { code: 'TIMEOUT' } });
    expect(elapsed).toBeGreaterThanOrEqual(195);
    expect(elapsed).toBeLessThan(1_000);
    expect(portal.requests).toHaveLength(1);
  });

  it('con el puerto cerrado da connection_error', async () => {
    const closed = await startFakePortal();
    const url = closed.url;
    await closed.close();

    const result = await createClient({ portalUrl: url }).put('acc-1', range);

    expect(result).toMatchObject({ outcome: 'connection_error', status: null, error: { code: 'CONNECTION_ERROR' } });
  });
});

describe('limitador de ventana deslizante', () => {
  it('con límite N, el portal nunca recibe más de N peticiones en ninguna ventana', async () => {
    const limit = 3;
    const windowMs = 400;
    const client = createClient({ portalRateLimit: limit, windowMs });

    await client.put('acc-0', range);
    // Media ventana de separación antes de la ráfaga, para preparar el escenario (no se espera
    // ningún resultado): una ventana fija anclada en la primera petición, como la del portal,
    // dejaría pasar 2 + 3 peticiones en 400 ms; la deslizante, solo 3.
    await delay(windowMs / 2);
    const results = await Promise.all(
      Array.from({ length: 7 }, (_, i) => client.put(`acc-${String(i + 1)}`, range)),
    );

    expect(results.every((r) => r.outcome === 'success')).toBe(true);
    const arrivals = portal.requests.map((r) => r.receivedAtMs);
    expect(arrivals).toHaveLength(8);
    // En una ventana deslizante, la petición i+N llega como pronto una ventana después de la i.
    for (let i = 0; i + limit < arrivals.length; i++) {
      const gap = (arrivals[i + limit] ?? 0) - (arrivals[i] ?? 0);
      expect(gap).toBeGreaterThanOrEqual(windowMs - LATENCY_TOLERANCE_MS);
    }
  });

  it('adelantar el reloj no acorta la ventana', async () => {
    const windowMs = 400;
    const client = createClient({ portalRateLimit: 1, windowMs });

    await client.put('acc-1', range);
    advanceClock(DAY_MS);
    await client.put('acc-2', range);

    const [gap] = arrivalsAfter(0);
    expect(gap).toBeGreaterThanOrEqual(windowMs - LATENCY_TOLERANCE_MS);
  });
});

describe('pausa global por 429', () => {
  it('tras un 429 con Retry-After, ninguna petición de ningún alojamiento llega antes de que pase', async () => {
    portal.enqueue(rateLimited(1));
    const client = createClient();

    const first = await client.put('acc-1', range);
    const others = await Promise.all([client.put('acc-1', range), client.put('acc-2', range), client.put('acc-3', range)]);

    expect(first).toMatchObject({ outcome: 'rate_limited', status: 429, retryAfterMs: 1_000 });
    expect(others.map((r) => r.outcome)).toStrictEqual(['success', 'success', 'success']);
    // La pausa empieza cuando el cliente recibe el 429, después de que el portal reciba la petición.
    for (const gap of arrivalsAfter(0)) {
      expect(gap).toBeGreaterThanOrEqual(1_000);
    }
    expect(logs.events('portal.rate_limited')).toStrictEqual([
      expect.objectContaining({
        level: 40,
        accommodationId: 'acc-1',
        from: range.from,
        to: range.to,
        status: 429,
        retryAfter: 1,
      }),
    ]);
  });

  it.each<[string, Record<string, string>]>([
    ['sin cabecera', {}],
    ['con una cabecera que no son segundos', { 'Retry-After': 'abc' }],
    ['con una fecha en formato obsoleto (RFC 850)', { 'Retry-After': 'Wednesday, 21-Oct-26 07:28:00 GMT' }],
  ])('%s se usa la pausa por defecto', async (_name, headers) => {
    portal.enqueue({ status: 429, headers });
    const client = createClient({ defaultRetryAfterMs: 300 });

    const first = await client.put('acc-1', range);
    await client.put('acc-2', range);

    expect(first).toMatchObject({ outcome: 'rate_limited', retryAfterMs: 300 });
    const [gap] = arrivalsAfter(0);
    expect(gap).toBeGreaterThanOrEqual(300);
    expect(logs.events('portal.rate_limited')).toStrictEqual([expect.objectContaining({ retryAfter: 0.3 })]);
  });

  it('con una fecha HTTP, la pausa dura hasta esa fecha según el reloj del servicio', async () => {
    // Con el reloj adelantado, la fecha se interpreta respecto a now(), no a la hora real.
    advanceClock(DAY_MS);
    // La fecha HTTP tiene resolución de segundos: se alinea al segundo siguiente y se suma 1 s,
    // así la pausa queda entre 1 s (menos lo que tarde la petición) y 2 s.
    const retryAt = new Date(Math.ceil(now().getTime() / 1_000) * 1_000 + 1_000).toUTCString();
    portal.enqueue({ status: 429, headers: { 'Retry-After': retryAt } });
    const client = createClient();

    const first = await client.put('acc-1', range);
    await client.put('acc-2', range);

    if (first.outcome !== 'rate_limited') throw new Error(`Se esperaba rate_limited: ${first.outcome}`);
    expect(first.retryAfterMs).toBeGreaterThan(500);
    expect(first.retryAfterMs).toBeLessThanOrEqual(2_000);
    const [gap] = arrivalsAfter(0);
    expect(gap).toBeGreaterThanOrEqual(first.retryAfterMs);
    expect(logs.events('portal.rate_limited')).toStrictEqual([
      expect.objectContaining({ retryAfter: first.retryAfterMs / 1000 }),
    ]);
  });

  it('con una fecha HTTP ya pasada no hay pausa', async () => {
    const retryAt = new Date(now().getTime() - 10_000).toUTCString();
    portal.enqueue({ status: 429, headers: { 'Retry-After': retryAt } });

    const result = await createClient().put('acc-1', range);

    expect(result).toMatchObject({ outcome: 'rate_limited', retryAfterMs: 0 });
    expect(logs.events('portal.rate_limited')).toStrictEqual([expect.objectContaining({ retryAfter: 0 })]);
  });

  it('adelantar el reloj no acorta la pausa', async () => {
    portal.enqueue(rateLimited());
    const client = createClient({ defaultRetryAfterMs: 400 });

    await client.put('acc-1', range);
    advanceClock(DAY_MS);
    await client.put('acc-1', range);

    const [gap] = arrivalsAfter(0);
    expect(gap).toBeGreaterThanOrEqual(400);
  });
});

describe('esperas interrumpibles', () => {
  it('la espera del limitador se interrumpe sin enviar nada', async () => {
    const client = createClient({ portalRateLimit: 1, windowMs: 60_000 });
    await client.put('acc-1', range);
    const controller = new AbortController();
    const started = performance.now();

    const waiting = client.put('acc-2', range, { signal: controller.signal });
    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(portal.requests).toHaveLength(1);
  });

  it('la espera de la pausa por 429 se interrumpe sin enviar nada', async () => {
    portal.enqueue(rateLimited(60));
    const client = createClient();
    await client.put('acc-1', range);
    const controller = new AbortController();
    const started = performance.now();

    const waiting = client.put('acc-2', range, { signal: controller.signal });
    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(portal.requests).toHaveLength(1);
  });

  it('con la señal ya abortada no envía nada', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(createClient().put('acc-1', range, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(portal.requests).toHaveLength(0);
  });
});

describe('rango enviado (invariante 6)', () => {
  it('acepta un rango de 31 días', async () => {
    const result = await createClient().put('acc-1', rangeFromToday(31));

    expect(result.outcome).toBe('success');
    expect(portal.requests).toHaveLength(1);
  });

  it.each<[string, () => PortalRange]>([
    ['más de 31 días', () => rangeFromToday(32)],
    ['una fecha inexistente', () => ({ ...range, to: `${range.from.slice(0, 4)}-02-30` })],
    ['to anterior a from', () => ({ ...range, from: range.to, to: range.from })],
  ])('con %s lanza un error de programación sin enviar nada', async (_name, invalid) => {
    await expect(createClient().put('acc-1', invalid())).rejects.toThrow(RangeError);
    expect(portal.requests).toHaveLength(0);
  });
});
