import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { advanceClock, now, resetClock } from '../../src/clock.js';
import { loadConfig } from '../../src/config.js';
import { addDays, todayUtc, type Day } from '../../src/dates.js';
import type { AccommodationDoc } from '../../src/storage/types.js';
import { ok, startFakePortal, type FakePortal, type FakeResponse } from '../helpers/fake-portal.js';
import { startTestMongo, type TestMongo } from '../helpers/mongo.js';
import { startService, type TestService } from '../helpers/service.js';
import { waitFor } from '../helpers/wait-for.js';

const ID = 'acc-1003';
const DAY_MS = 86_400_000;
const WORKER_IDLE_MS = 300;
const { leaseMs: LEASE_MS } = loadConfig({});

/** Día relativo a "hoy" según el reloj controlado. */
function day(offset: number): Day {
  return addDays(todayUtc(now()), offset);
}

describe('worker con MongoDB caído', () => {
  let mongo: TestMongo;
  let portal: FakePortal;
  let service: TestService | null = null;

  beforeAll(async () => {
    // Una instancia propia, porque se para.
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
    await service?.close();
    service = null;
    resetClock();
  });

  async function load(running: TestService): Promise<AccommodationDoc> {
    const doc = await running.storage.accommodations.findOne({ _id: ID });
    if (doc === null) throw new Error(`No existe el documento de ${ID}`);
    return doc;
  }

  it('registra el error, duerme WORKER_IDLE_MS y, cuando MongoDB vuelve, termina de sincronizar lo pendiente', async () => {
    // Con un timeout de selección corto, cada operación falla enseguida en lugar de a los 30 s.
    const running = await startService(
      `${mongo.freshUrl()}?serverSelectionTimeoutMS=100`,
      { portalUrl: portal.url, workerIdleMs: WORKER_IDLE_MS },
      { worker: true },
    );
    service = running;
    const held = Promise.withResolvers<FakeResponse>();
    portal.enqueue(() => held.promise);

    const body = { accommodationId: ID, from: day(1), to: day(3), available: true, pricePerNight: 100 };
    const response = await fetch(`${running.url}/updates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(202);
    await waitFor(() => portal.requests.length === 1, { message: 'el primer PUT' });

    // MongoDB cae con el PUT en camino: el worker no puede guardar el 200 y no libera el lease.
    await mongo.pause();
    held.resolve(ok());

    const errors = await waitFor(
      () => {
        const lines = running.logs.events('worker.storage_error');
        return lines.length >= 3 ? lines : null;
      },
      { message: 'varios worker.storage_error' },
    );
    expect(errors[0]?.level).toBe(50);
    expect((errors[0]?.err as { type?: unknown } | undefined)?.type).toMatch(/^Mongo/);
    // Entre un fallo y el siguiente, el worker duerme WORKER_IDLE_MS.
    for (let i = 1; i < errors.length; i++) {
      expect(Number(errors[i]?.time) - Number(errors[i - 1]?.time)).toBeGreaterThanOrEqual(WORKER_IDLE_MS);
    }

    await mongo.resume();
    // El lease caduca y el alojamiento se retoma con el estado actual.
    advanceClock(LEASE_MS);
    await waitFor(
      async () => {
        const doc = await load(running);
        return doc.status === 'synced' && doc.leaseUntil === null;
      },
      { timeoutMs: 15_000, message: `que ${ID} quede synced` },
    );

    const { accommodationId, ...range } = body;
    expect(portal.requests.map((request) => [request.accommodationId, request.body])).toEqual([
      [accommodationId, range],
      [accommodationId, range],
    ]);
    expect(running.logs.events('worker.lease_expired')).toHaveLength(1);
  }, 30_000);
});
