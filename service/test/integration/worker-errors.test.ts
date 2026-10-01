import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { advanceClock, now, resetClock } from '../../src/clock.js';
import { addDays, todayUtc, type Day } from '../../src/dates.js';
import type { SyncStatusResponse } from '../../src/status/route.js';
import type { AccommodationDoc } from '../../src/storage/types.js';
import { ok, startFakePortal, type FakePortal, type FakeResponse } from '../helpers/fake-portal.js';
import { startTestMongo, type TestMongo } from '../helpers/mongo.js';
import { startService, type TestService } from '../helpers/service.js';
import { waitFor } from '../helpers/wait-for.js';

const ID = 'acc-1003';
const OTHER = 'acc-2001';
const DAY_MS = 86_400_000;

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

describe('worker: errores permanentes', () => {
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

  async function start(): Promise<TestService> {
    service = await startService(mongo.freshUrl(), { portalUrl: portal.url }, { worker: true });
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

  /** Espera a que el alojamiento tenga ese estado y el lease esté liberado. */
  function waitStatus(status: AccommodationDoc['status'], id = ID): Promise<AccommodationDoc> {
    return waitFor(
      async () => {
        const doc = await load(id);
        return doc.status === status && doc.leaseUntil === null ? doc : null;
      },
      { message: `que ${id} quede ${status}` },
    );
  }

  function puts(id = ID): typeof portal.requests {
    return portal.requests.filter((request) => request.method === 'PUT' && request.accommodationId === id);
  }

  it('CA-8: un alojamiento inexistente se acepta, termina en error sin más reintentos y un update nuevo lo devuelve a pending', async () => {
    await start();
    portal.setDefault((request) => (request.accommodationId === ID ? { status: 404 } : ok()));

    await post({ from: day(1), to: day(2), available: true, pricePerNight: 100 });
    await waitStatus('error');

    const status = await syncStatus();
    expect(status).toMatchObject({
      status: 'error',
      nextAttemptAt: null,
      lastError: { code: 'NOT_FOUND' },
      pendingDays: 2,
      pendingRanges: [{ from: day(1), to: day(2), available: true, pricePerNight: 100 }],
    });
    expect(running().logs.events('sync.accommodation.error')).toEqual([
      expect.objectContaining({ level: 50, accommodationId: ID, status: 404, errorCode: 'NOT_FOUND' }),
    ]);

    // Sin más reintentos: otro alojamiento se sincroniza y este no se vuelve a enviar.
    await post({ accommodationId: OTHER, from: day(1), to: day(1), available: true, pricePerNight: 90 });
    await waitStatus('synced', OTHER);
    expect(puts()).toHaveLength(1);

    // Un update nuevo, aunque no cambie ningún valor, lo devuelve a pending y se vuelve a enviar.
    portal.setDefault(ok());
    await post({ from: day(1), to: day(2), available: true, pricePerNight: 100 });
    await waitStatus('synced');

    expect(puts().map(({ status: code, body }) => ({ status: code, body }))).toEqual([
      { status: 404, body: { from: day(1), to: day(2), available: true, pricePerNight: 100 } },
      { status: 200, body: { from: day(1), to: day(2), available: true, pricePerNight: 100 } },
    ]);
  });

  it('si llega un update mientras se procesa un 404, se reintenta de inmediato y solo pasa a error si vuelve a fallar sin cambios', async () => {
    await start();
    const first = Promise.withResolvers<FakeResponse>();
    const retry = Promise.withResolvers<FakeResponse>();
    portal.enqueue(
      () => first.promise,
      () => retry.promise,
    );

    await post({ from: day(1), to: day(2), available: true, pricePerNight: 100 });
    await waitFor(() => puts().length === 1, { message: 'el primer PUT' });
    await post({ from: day(1), to: day(2), available: false, pricePerNight: 120 });

    first.resolve({ status: 404 });
    await waitFor(() => puts().length === 2, { message: 'el reintento inmediato' });

    // Mientras el reintento está en camino, el alojamiento no está en error, y el reintento es
    // inmediato (sin backoff) y no cuenta como fallo.
    const retrying = await load();
    expect(retrying).toMatchObject({ status: 'pending', seq: 2, attempts: 0, lastError: { code: 'NOT_FOUND' } });
    expect(retrying.nextAttemptAt).toEqual(retrying.lastError?.at);
    expect(running().logs.events('sync.accommodation.error')).toEqual([]);

    retry.resolve({ status: 404 });
    const doc = await waitStatus('error');

    expect(doc).toMatchObject({ seq: 2, nextAttemptAt: null, lastError: { code: 'NOT_FOUND' } });
    expect(puts().map((r) => r.body)).toEqual([
      { from: day(1), to: day(2), available: true, pricePerNight: 100 },
      { from: day(1), to: day(2), available: false, pricePerNight: 120 },
    ]);
    expect(running().logs.events('sync.accommodation.error')).toHaveLength(1);
  });

  it.each([400, 409, 422])('un %i se trata igual que el 404', async (code) => {
    await start();
    portal.setDefault((request) => (request.accommodationId === ID ? { status: code } : ok()));

    await post({ from: day(1), to: day(1), available: true, pricePerNight: 100 });
    const doc = await waitStatus('error');

    expect(doc).toMatchObject({ nextAttemptAt: null, pending: true, lastError: { at: expect.any(Date) as Date } });
    expect(running().logs.events('sync.accommodation.error')).toEqual([
      expect.objectContaining({ level: 50, accommodationId: ID, status: code }),
    ]);

    // Sin más reintentos: otro alojamiento se sincroniza y este no se vuelve a enviar.
    await post({ accommodationId: OTHER, from: day(1), to: day(1), available: true, pricePerNight: 90 });
    await waitStatus('synced', OTHER);
    expect(puts()).toHaveLength(1);
  });
});
