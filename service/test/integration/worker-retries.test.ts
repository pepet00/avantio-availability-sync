import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMs, advanceClock, now, resetClock } from '../../src/clock.js';
import type { Config } from '../../src/config.js';
import { addDays, todayUtc, type Day } from '../../src/dates.js';
import type { SyncStatusResponse } from '../../src/status/route.js';
import type { AccommodationDoc, LastError } from '../../src/storage/types.js';
import {
  NO_RESPONSE,
  ok,
  rateLimited,
  startFakePortal,
  type FakePortal,
  type FakeResponse,
} from '../helpers/fake-portal.js';
import { startTestMongo, type TestMongo } from '../helpers/mongo.js';
import { startService, type TestService } from '../helpers/service.js';
import { waitFor } from '../helpers/wait-for.js';

const ID = 'acc-1003';
const OTHER = 'acc-2001';
const DAY_MS = 86_400_000;
const BACKOFF_BASE_MS = 20;
/** Azar fijo: el backoff del fallo n es exactamente la mitad de su tope. */
const HALF = (): number => 0.5;

interface SentRange {
  from: Day;
  to: Day;
  available: boolean;
  pricePerNight: number;
}

/** Día relativo a "hoy" según el reloj controlado. */
function day(offset: number): Day {
  return addDays(todayUtc(now()), offset);
}

/** Adelanta el reloj hasta pasado `instant`. */
function advanceTo(instant: Date): void {
  advanceClock(Math.max(0, instant.getTime() - now().getTime()) + 1);
}

describe('worker: reintentos, timeouts y 429', () => {
  let mongo: TestMongo;
  let portal: FakePortal;
  let service: TestService | null = null;

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
    // Corta las respuestas retenidas para que la parada no espere al timeout.
    portal.reset();
    await service?.close();
    service = null;
    resetClock();
  });

  async function start(overrides: Partial<Config> = {}): Promise<TestService> {
    service = await startService(
      mongo.freshUrl(),
      { portalUrl: portal.url, backoffBaseMs: BACKOFF_BASE_MS, ...overrides },
      { worker: true, random: HALF },
    );
    return service;
  }

  function running(): TestService {
    if (service === null) throw new Error('El servicio no está arrancado');
    return service;
  }

  async function post(body: SentRange & { accommodationId?: string }): Promise<void> {
    const response = await fetch(`${running().url}/updates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accommodationId: ID, ...body }),
    });
    expect(response.status).toBe(202);
  }

  async function syncStatus(id = ID): Promise<SyncStatusResponse> {
    const response = await fetch(`${running().url}/accommodations/${id}/sync-status`);
    expect(response.status).toBe(200);
    return (await response.json()) as SyncStatusResponse;
  }

  async function load(id = ID): Promise<AccommodationDoc> {
    const doc = await running().storage.accommodations.findOne({ _id: id });
    if (doc === null) throw new Error(`No existe el documento de ${id}`);
    return doc;
  }

  /** Espera a que no quede nada pendiente y el lease esté liberado. */
  function waitSynced(id = ID): Promise<AccommodationDoc> {
    return waitFor(
      async () => {
        const doc = await load(id);
        return doc.status === 'synced' && doc.leaseUntil === null ? doc : null;
      },
      { message: `que ${id} quede synced` },
    );
  }

  /** Espera a que el worker haya registrado el fallo número `attempts` y soltado el lease. */
  function waitFailures(attempts: number, id = ID): Promise<AccommodationDoc & { lastError: LastError; nextAttemptAt: Date }> {
    return waitFor(
      async () => {
        const doc = await load(id);
        const { lastError, nextAttemptAt } = doc;
        if (doc.attempts !== attempts || doc.leaseUntil !== null || lastError === null || nextAttemptAt === null) {
          return null;
        }
        return { ...doc, lastError, nextAttemptAt };
      },
      { message: `${String(attempts)} fallos de ${id}` },
    );
  }

  function puts(id = ID): typeof portal.requests {
    return portal.requests.filter((request) => request.method === 'PUT' && request.accommodationId === id);
  }

  it('CA-4: tras un 429 con Retry-After no llega ninguna petición antes de que pase, y attempts no cambia', async () => {
    await start();
    const attemptsOnRetry: number[] = [];
    portal.enqueue(rateLimited(1));
    portal.setDefault(async (request) => {
      if (request.accommodationId === ID) attemptsOnRetry.push((await load()).attempts);
      return ok();
    });

    await post({ from: day(1), to: day(2), available: true, pricePerNight: 100 });
    await post({ accommodationId: OTHER, from: day(1), to: day(1), available: true, pricePerNight: 90 });
    await waitSynced();
    await waitSynced(OTHER);

    const [limited, ...rest] = portal.requests;
    expect(limited).toMatchObject({ accommodationId: ID, status: 429 });
    expect(rest.map((r) => r.accommodationId).sort()).toEqual([ID, OTHER]);
    for (const request of rest) {
      expect(request.receivedAtMs - (limited?.receivedAtMs ?? Infinity)).toBeGreaterThanOrEqual(1_000);
    }
    // Ni el 429 ni la pausa cuentan como fallo.
    expect(attemptsOnRetry).toEqual([0]);
    expect(await load()).toMatchObject({ attempts: 0, lastError: null });
  });

  it('un update que llega durante la pausa por 429 sale en el primer PUT tras ella: se lee el documento después de esperar', async () => {
    await start();
    portal.enqueue(rateLimited(1));

    await post({ from: day(1), to: day(2), available: true, pricePerNight: 100 });
    const limited = await waitFor(() => puts().find((r) => r.status === 429), { message: 'el 429' });
    // A mitad de la pausa: lejos del 429 (si el worker leyera antes de esperar, ya lo habría hecho)
    // y lejos del final. No espera un resultado, sitúa el update dentro de la pausa.
    await waitFor(() => performance.now() - limited.receivedAtMs >= 500, { message: 'la mitad de la pausa' });
    await post({ from: day(1), to: day(2), available: false, pricePerNight: 120 });
    await waitSynced();

    expect(puts().map(({ status, body }) => ({ status, body }))).toEqual([
      { status: 429, body: { from: day(1), to: day(2), available: true, pricePerNight: 100 } },
      { status: 200, body: { from: day(1), to: day(2), available: false, pricePerNight: 120 } },
    ]);
  });

  it('CA-5: tras un timeout no se envía nada del alojamiento antes del margen; después, el estado actual', async () => {
    const GRACE_MS = 60_000;
    await start({ portalTimeoutMs: 200, timeoutGraceMs: GRACE_MS });
    portal.enqueue(NO_RESPONSE);

    await post({ from: day(1), to: day(2), available: true, pricePerNight: 100 });
    const failed = await waitFailures(1);
    expect(failed.lastError.code).toBe('TIMEOUT');
    const graceEnd = addMs(failed.lastError.at, GRACE_MS);
    expect(failed.nextAttemptAt).toEqual(graceEnd);

    // Un update nuevo durante el margen no lo adelanta; otro alojamiento sí se envía mientras tanto.
    await post({ from: day(1), to: day(2), available: false, pricePerNight: 120 });
    await post({ accommodationId: OTHER, from: day(1), to: day(1), available: true, pricePerNight: 90 });
    await waitSynced(OTHER);
    expect(puts()).toHaveLength(1);
    expect((await load()).nextAttemptAt).toEqual(graceEnd);

    advanceTo(graceEnd);
    await waitSynced();

    const [timedOut, resent] = puts();
    expect(timedOut?.status).toBeNull();
    expect(resent?.at.getTime()).toBeGreaterThanOrEqual(graceEnd.getTime());
    expect(resent?.body).toEqual({ from: day(1), to: day(2), available: false, pricePerNight: 120 });
    expect(puts()).toHaveLength(2);
  });

  it('un 503 y un 200: attempts pasa a 1 con lastError y nextAttemptAt en sync-status, y vuelve a 0', async () => {
    await start();
    const retry = Promise.withResolvers<FakeResponse>();
    portal.enqueue({ status: 503 }, () => retry.promise);

    await post({ from: day(1), to: day(2), available: true, pricePerNight: 100 });
    await waitFor(() => portal.requests.length === 2, { message: 'el reintento' });

    const failing = await syncStatus();
    expect(failing).toMatchObject({ status: 'pending', attempts: 1, lastError: { code: 'UNAVAILABLE' } });
    const lastErrorAt = new Date(failing.lastError?.at ?? NaN);
    expect(failing.nextAttemptAt).toBe(addMs(lastErrorAt, BACKOFF_BASE_MS / 2).toISOString());

    retry.resolve(ok());
    await waitSynced();

    expect(await syncStatus()).toMatchObject({ status: 'synced', attempts: 0, lastError: null, nextAttemptAt: null });
  });

  it('al primer fallo se detiene: los rangos confirmados quedan confirmados y los restantes no se envían', async () => {
    // Backoff largo: el reintento no llega durante el test.
    await start({ backoffBaseMs: 60_000, backoffMaxMs: 60_000 });
    portal.enqueue(ok(), { status: 503 });

    // 90 días iguales: tres rangos.
    await post({ from: day(1), to: day(90), available: true, pricePerNight: 80 });
    const doc = await waitFailures(1);

    expect(puts().map((r) => r.status)).toEqual([200, 503]);
    expect(doc.days[day(1)]).toMatchObject({ syncedVersion: 1 });
    expect(doc.days[day(31)]).toMatchObject({ syncedVersion: 1 });
    expect(doc.days[day(32)]).toMatchObject({ syncedVersion: 0 });
    expect(doc.days[day(90)]).toMatchObject({ syncedVersion: 0 });
    expect(doc.nextAttemptAt.getTime()).toBeGreaterThan(now().getTime());
  });

  it('con FAILING_THRESHOLD fallos pasa a failing una sola vez, un update no adelanta el reintento y un 200 lo sincroniza', async () => {
    await start({ failingThreshold: 2, backoffBaseMs: 60_000, backoffMaxMs: 600_000 });
    portal.setDefault({ status: 503 });

    await post({ from: day(1), to: day(1), available: true, pricePerNight: 100 });
    let doc = await waitFailures(1);
    expect(doc.status).toBe('pending');
    for (const attempts of [2, 3]) {
      advanceTo(doc.nextAttemptAt);
      doc = await waitFailures(attempts);
      expect(doc.status).toBe('failing');
    }

    const { logs } = running();
    expect(logs.events('sync.put.failed').map((e) => e.attempt)).toEqual([1, 2, 3]);
    expect(logs.events('sync.accommodation.failing')).toEqual([
      expect.objectContaining({ level: 50, accommodationId: ID, attempt: 2 }),
    ]);

    // En failing, un update nuevo no adelanta el reintento.
    const scheduled = doc.nextAttemptAt;
    await post({ from: day(1), to: day(1), available: true, pricePerNight: 200 });
    expect(await load()).toMatchObject({ seq: 2, status: 'failing', nextAttemptAt: scheduled });
    expect(puts()).toHaveLength(3);

    portal.setDefault(ok());
    advanceTo(scheduled);
    const synced = await waitSynced();

    expect(synced).toMatchObject({ attempts: 0, lastError: null });
    expect(puts().at(-1)?.body).toMatchObject({ pricePerNight: 200 });
  });

  it('un 401 se reintenta como un 5xx', async () => {
    await start();
    const retry = Promise.withResolvers<FakeResponse>();
    portal.enqueue({ status: 401 }, () => retry.promise);

    await post({ from: day(1), to: day(1), available: true, pricePerNight: 100 });
    await waitFor(() => portal.requests.length === 2, { message: 'el reintento' });

    // Backoff de un 5xx, sin el margen de un timeout.
    const failed = await load();
    expect(failed).toMatchObject({ status: 'pending', attempts: 1, lastError: { code: 'UNAUTHORIZED' } });
    expect(failed.nextAttemptAt).toEqual(addMs(failed.lastError?.at ?? new Date(NaN), BACKOFF_BASE_MS / 2));
    expect(running().logs.events('sync.put.failed')).toEqual([
      expect.objectContaining({ level: 40, status: 401, errorCode: 'UNAUTHORIZED', attempt: 1 }),
    ]);

    retry.resolve(ok());
    await waitSynced();
    expect(puts().map((r) => r.status)).toEqual([401, 200]);
  });

  it('si un update pide reintentar ya mientras el PUT está en camino y este falla con 503, manda el backoff', async () => {
    await start({ backoffBaseMs: 60_000, backoffMaxMs: 60_000 });
    const held = Promise.withResolvers<FakeResponse>();
    portal.enqueue(() => held.promise);

    await post({ from: day(1), to: day(2), available: true, pricePerNight: 100 });
    await waitFor(() => portal.requests.length === 1, { message: 'el primer PUT' });
    await post({ from: day(1), to: day(2), available: false, pricePerNight: 120 });
    // El update deja el siguiente intento para ya.
    expect((await load()).nextAttemptAt?.getTime()).toBeLessThanOrEqual(now().getTime());

    held.resolve({ status: 503 });
    const doc = await waitFailures(1);

    expect(doc.seq).toBe(2);
    expect(doc.days[day(1)]).toMatchObject({ available: false, version: 2, syncedVersion: 0 });
    expect(doc.nextAttemptAt).toEqual(addMs(doc.lastError.at, 30_000));
    expect(puts()).toHaveLength(1);
  });
});
