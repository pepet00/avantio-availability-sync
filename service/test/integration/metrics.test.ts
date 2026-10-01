import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMs, advanceClock, now, resetClock } from '../../src/clock.js';
import type { Config } from '../../src/config.js';
import { addDays, todayUtc, type Day } from '../../src/dates.js';
import type { SyncStatusResponse } from '../../src/status/route.js';
import type { AccommodationDoc, SyncStatus } from '../../src/storage/types.js';
import { ok, rateLimited, startFakePortal, type FakePortal, type FakeResponse } from '../helpers/fake-portal.js';
import { startTestMongo, type TestMongo } from '../helpers/mongo.js';
import { startService, type ServiceOptions, type TestService } from '../helpers/service.js';
import { waitFor } from '../helpers/wait-for.js';

const ID = 'acc-1003';
const OTHER = 'acc-2001';
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Muestras del formato de texto de Prometheus (sin comentarios `# HELP` / `# TYPE`). */
function parseMetrics(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (match === null) throw new Error(`Línea de métricas no reconocida: ${line}`);
    const [, name = '', rawLabels = '', value = ''] = match;
    const labels: Record<string, string> = {};
    for (const [, key = '', labelValue = ''] of rawLabels.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) {
      labels[key] = labelValue;
    }
    samples.push({ name, labels, value: Number(value) });
  }
  return samples;
}

/** Valor de la muestra con ese nombre cuyas etiquetas incluyen `labels`; `undefined` si no hay. */
function sample(samples: readonly Sample[], name: string, labels: Record<string, string> = {}): number | undefined {
  return samples.find(
    (s) => s.name === name && Object.entries(labels).every(([key, value]) => s.labels[key] === value),
  )?.value;
}

/** Día relativo a "hoy" según el reloj controlado. */
function day(offset: number): Day {
  return addDays(todayUtc(now()), offset);
}

describe('GET /metrics', () => {
  let mongo: TestMongo;
  let portal: FakePortal;
  let services: TestService[] = [];

  beforeAll(async () => {
    mongo = await startTestMongo();
    portal = await startFakePortal();
  }, 120_000);

  afterAll(async () => {
    await portal.close();
    await mongo.stop();
  });

  beforeEach(() => {
    // Un "hoy" que no es el real: las fechas deben salir del reloj del servicio.
    advanceClock(400 * DAY_MS);
    portal.reset();
  });

  afterEach(async () => {
    portal.reset();
    for (const service of services) await service.close();
    services = [];
    resetClock();
  });

  async function start(
    mongoUrl = mongo.freshUrl(),
    overrides: Partial<Config> = {},
    options: ServiceOptions = {},
  ): Promise<TestService> {
    const service = await startService(mongoUrl, { portalUrl: portal.url, ...overrides }, options);
    services.push(service);
    return service;
  }

  /** Con worker y azar fijo (el backoff es la mitad de su tope). */
  function startWithWorker(): Promise<TestService> {
    return start(mongo.freshUrl(), {}, { worker: true, random: () => 0.5 });
  }

  async function stop(service: TestService): Promise<void> {
    services = services.filter((s) => s !== service);
    await service.close();
  }

  async function post(service: TestService, accommodationId = ID): Promise<void> {
    const response = await fetch(`${service.url}/updates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accommodationId, from: day(1), to: day(2), available: true, pricePerNight: 100 }),
    });
    expect(response.status).toBe(202);
  }

  async function syncStatus(service: TestService): Promise<SyncStatusResponse> {
    const response = await fetch(`${service.url}/accommodations/${ID}/sync-status`);
    expect(response.status).toBe(200);
    return (await response.json()) as SyncStatusResponse;
  }

  async function metrics(service: TestService): Promise<{ text: string; samples: Sample[] }> {
    const response = await fetch(`${service.url}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/plain/);
    const text = await response.text();
    return { text, samples: parseMetrics(text) };
  }

  function waitSynced(service: TestService): Promise<AccommodationDoc> {
    return waitFor(
      async () => {
        const doc = await service.storage.accommodations.findOne({ _id: ID });
        return doc?.status === 'synced' && doc.leaseUntil === null ? doc : null;
      },
      { message: `que ${ID} quede synced` },
    );
  }

  function byStatus(samples: readonly Sample[]): Record<SyncStatus, number | undefined> {
    const of = (status: SyncStatus): number | undefined =>
      sample(samples, 'sync_accommodations_by_status', { status });
    return { synced: of('synced'), pending: of('pending'), failing: of('failing'), error: of('error') };
  }

  /** Documento sembrado con el estado indicado; `pendingSince` relativo a ahora. */
  function seeded(id: string, status: SyncStatus, pendingSinceAgoMs: number | null): AccommodationDoc {
    const at = now();
    const pending = status !== 'synced';
    return {
      _id: id,
      seq: 1,
      rev: 1,
      days: { [day(1)]: { available: true, price: 100, version: 1, syncedVersion: pending ? 0 : 1 } },
      pending,
      pendingSince: pendingSinceAgoMs === null ? null : addMs(at, -pendingSinceAgoMs),
      nextAttemptAt: status === 'pending' || status === 'failing' ? addMs(at, DAY_MS) : null,
      attempts: status === 'failing' ? 5 : 0,
      leaseUntil: null,
      status,
      lastError: status === 'error' ? { code: 'NOT_FOUND', message: 'No existe', at } : null,
      lastSyncedAt: null,
    };
  }

  it('CA-9: tras un 503 y un 200, attempts sube y vuelve a 0, y /metrics refleja la llamada fallida y el reintento', async () => {
    const service = await startWithWorker();
    const retry = Promise.withResolvers<FakeResponse>();
    portal.enqueue({ status: 503 }, () => retry.promise);

    await post(service);
    await waitFor(() => portal.requests.length === 2, { message: 'el reintento' });
    expect(await syncStatus(service)).toMatchObject({ status: 'pending', attempts: 1 });

    retry.resolve(ok());
    await waitSynced(service);
    expect(await syncStatus(service)).toMatchObject({ status: 'synced', attempts: 0 });

    const { samples } = await metrics(service);
    expect(sample(samples, 'portal_requests_total', { method: 'PUT', outcome: 'unavailable' })).toBe(1);
    expect(sample(samples, 'portal_requests_total', { method: 'PUT', outcome: 'success' })).toBe(1);
    expect(sample(samples, 'sync_retries_total', { reason: 'unavailable' })).toBe(1);
  });

  it('CA-10: tras un reinicio con pendientes, la primera consulta da los gauges correctos', async () => {
    const mongoUrl = mongo.freshUrl();
    const first = await start(mongoUrl);
    await post(first, ID);
    advanceClock(MINUTE_MS);
    await post(first, OTHER);
    const oldest = (await first.storage.accommodations.findOne({ _id: ID }))?.pendingSince;
    if (oldest == null) throw new Error('El primer alojamiento no tiene pendingSince');
    await stop(first);

    advanceClock(10 * MINUTE_MS);
    const second = await start(mongoUrl);
    const before = now();
    const { samples } = await metrics(second);
    const after = now();

    expect(byStatus(samples)).toEqual({ synced: 0, pending: 2, failing: 0, error: 0 });
    const age = sample(samples, 'sync_oldest_pending_age_seconds');
    expect(age).toBeGreaterThanOrEqual((before.getTime() - oldest.getTime()) / 1000);
    expect(age).toBeLessThanOrEqual((after.getTime() - oldest.getTime()) / 1000);
  });

  it('sync_oldest_pending_age_seconds cuenta pending y failing, excluye error y vale 0 si no hay ninguno', async () => {
    const service = await start();
    const { accommodations } = service.storage;

    let { samples } = await metrics(service);
    expect(sample(samples, 'sync_oldest_pending_age_seconds')).toBe(0);
    expect(byStatus(samples)).toEqual({ synced: 0, pending: 0, failing: 0, error: 0 });

    // Solo un `error` (con el pendiente más viejo de todos) y un `synced`: 0.
    await accommodations.insertMany([seeded('acc-error', 'error', 300 * DAY_MS), seeded('acc-synced', 'synced', null)]);
    ({ samples } = await metrics(service));
    expect(sample(samples, 'sync_oldest_pending_age_seconds')).toBe(0);
    expect(byStatus(samples)).toEqual({ synced: 1, pending: 0, failing: 0, error: 1 });

    // Con un `pending` y un `failing` más viejo, cuenta el `failing`, no el `error`.
    await accommodations.insertMany([
      seeded('acc-pending', 'pending', 5 * MINUTE_MS),
      seeded('acc-failing', 'failing', 60 * MINUTE_MS),
    ]);
    ({ samples } = await metrics(service));
    const age = sample(samples, 'sync_oldest_pending_age_seconds') ?? NaN;
    expect(age).toBeGreaterThanOrEqual(60 * 60);
    expect(age).toBeLessThan(60 * 60 + 5);
    expect(byStatus(samples)).toEqual({ synced: 1, pending: 1, failing: 1, error: 1 });
  });

  it('un 429 cuenta en portal_requests_total{outcome="rate_limited"} y no en sync_retries_total', async () => {
    const service = await startWithWorker();
    portal.enqueue(rateLimited(0));

    await post(service);
    await waitSynced(service);

    const { samples } = await metrics(service);
    expect(sample(samples, 'portal_requests_total', { method: 'PUT', outcome: 'rate_limited' })).toBe(1);
    expect(sample(samples, 'portal_requests_total', { method: 'PUT', outcome: 'success' })).toBe(1);
    expect(samples.filter((s) => s.name === 'sync_retries_total')).toEqual([]);
  });

  it('el histograma tiene buckets hasta 15 s y ninguna métrica lleva la etiqueta accommodationId', async () => {
    const service = await startWithWorker();
    portal.enqueue({ status: 503 });

    await post(service);
    await waitSynced(service);

    const { text, samples } = await metrics(service);
    const buckets = samples
      .filter((s) => s.name === 'portal_request_duration_seconds_bucket' && s.labels.outcome === 'success')
      .map((s) => s.labels.le);
    expect(buckets.at(-1)).toBe('+Inf');
    expect(Math.max(...buckets.slice(0, -1).map(Number))).toBe(15);
    // También las del proceso Node.
    expect(text).toContain('process_cpu_user_seconds_total');

    expect(sample(samples, 'sync_retries_total')).toBe(1);
    expect(samples.filter((s) => 'accommodationId' in s.labels)).toEqual([]);
    expect(text).not.toContain(ID);
  });
});

describe('GET /metrics con MongoDB parado', () => {
  let mongo: TestMongo;
  let service: TestService;

  beforeEach(async () => {
    // Una instancia propia, porque se para; con un timeout de selección corto para no esperar 30 s.
    mongo = await startTestMongo();
    service = await startService(`${mongo.freshUrl()}?serverSelectionTimeoutMS=500`);
  }, 120_000);

  afterEach(async () => {
    await service.close();
    await mongo.stop();
  });

  it('responde 503 STORAGE_UNAVAILABLE', async () => {
    await mongo.stop();

    const response = await fetch(`${service.url}/metrics`);

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: { code?: unknown } };
    expect(body.error?.code).toBe('STORAGE_UNAVAILABLE');
  }, 15_000);
});
