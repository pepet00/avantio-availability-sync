import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMs, advanceClock, now, resetClock } from '../../src/clock.js';
import { addDays, todayUtc, type Day } from '../../src/dates.js';
import type { AccommodationDoc } from '../../src/storage/types.js';
import type { DesiredDay } from '../../src/sync/grouping.js';
import { startTestMongo, type TestMongo } from '../helpers/mongo.js';
import { startService, type TestService } from '../helpers/service.js';

const ID = 'acc-1003';
const DAY_MS = 86_400_000;

const FIELDS = [
  'accommodationId',
  'status',
  'pendingDays',
  'pendingSince',
  'pendingRanges',
  'attempts',
  'nextAttemptAt',
  'lastError',
  'lastSyncedAt',
];

/** Día relativo a "hoy" según el reloj controlado. */
function day(offset: number): Day {
  return addDays(todayUtc(now()), offset);
}

/** Días `[from, to]` (relativos a hoy) con los mismos valores y versiones. */
function seedDays(from: number, to: number, state: DesiredDay): Record<string, DesiredDay> {
  const days: Record<string, DesiredDay> = {};
  for (let offset = from; offset <= to; offset++) days[day(offset)] = { ...state };
  return days;
}

async function post(service: TestService, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${service.url}/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accommodationId: ID, ...body }),
  });
  expect(response.status).toBe(202);
}

async function getStatus(service: TestService, id = ID): Promise<Response> {
  return fetch(`${service.url}/accommodations/${encodeURIComponent(id)}/sync-status`);
}

async function getStatusBody(service: TestService): Promise<Record<string, unknown>> {
  const response = await getStatus(service);
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual([...FIELDS].sort());
  return body;
}

describe('GET /accommodations/:id/sync-status', () => {
  let mongo: TestMongo;
  let service: TestService;

  beforeAll(async () => {
    mongo = await startTestMongo();
  }, 120_000);

  afterAll(async () => {
    await mongo.stop();
  });

  beforeEach(async () => {
    // Un "hoy" que no es el real: las fechas deben salir del reloj del servicio.
    advanceClock(400 * DAY_MS);
    service = await startService(mongo.freshUrl());
  });

  afterEach(async () => {
    resetClock();
    await service.close();
  });

  it('alojamiento del que nunca se recibió un update → 404 NOT_FOUND', async () => {
    const response = await getStatus(service, 'acc-desconocido');

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    expect(body.error?.code).toBe('NOT_FOUND');
    expect(typeof body.error?.message).toBe('string');
  });

  it('tras un POST: pending, con sus días y rangos agrupados como se enviarán', async () => {
    const before = now();
    await post(service, { from: day(1), to: day(3), available: true, pricePerNight: 120 });
    await post(service, { from: day(3), to: day(4), available: false, pricePerNight: 150 });
    const after = now();

    const body = await getStatusBody(service);

    expect(body).toMatchObject({
      accommodationId: ID,
      status: 'pending',
      pendingDays: 4,
      pendingRanges: [
        { from: day(1), to: day(2), available: true, pricePerNight: 120 },
        { from: day(3), to: day(4), available: false, pricePerNight: 150 },
      ],
      attempts: 0,
      lastError: null,
      lastSyncedAt: null,
    });
    // Ambos son instantes de los POST. Que pendingSince no se mueva con el segundo ya lo prueba T5.
    for (const field of ['pendingSince', 'nextAttemptAt']) {
      const instant = new Date(String(body[field])).getTime();
      expect(instant).toBeGreaterThanOrEqual(before.getTime());
      expect(instant).toBeLessThanOrEqual(after.getTime());
    }
  });

  it('en synced: todos los campos, con pendientes a null, 0 y vacío', async () => {
    const lastSyncedAt = now();
    await service.storage.accommodations.insertOne({
      _id: ID,
      seq: 1,
      rev: 3,
      days: seedDays(1, 3, { available: true, price: 120, version: 1, syncedVersion: 1 }),
      pending: false,
      pendingSince: null,
      nextAttemptAt: null,
      attempts: 0,
      leaseUntil: null,
      status: 'synced',
      lastError: null,
      lastSyncedAt,
    } satisfies AccommodationDoc);

    const body = await getStatusBody(service);

    expect(body).toEqual({
      accommodationId: ID,
      status: 'synced',
      pendingDays: 0,
      pendingSince: null,
      pendingRanges: [],
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      lastSyncedAt: lastSyncedAt.toISOString(),
    });
  });

  it('en error: pendingRanges sigue mostrando lo que falta, nextAttemptAt null y lastError visible', async () => {
    const pendingSince = now();
    const errorAt = addMs(pendingSince, 1_000);
    await service.storage.accommodations.insertOne({
      _id: ID,
      seq: 2,
      rev: 4,
      days: {
        ...seedDays(1, 2, { available: true, price: 120, version: 1, syncedVersion: 1 }),
        ...seedDays(3, 5, { available: false, price: 90, version: 2, syncedVersion: 1 }),
      },
      pending: true,
      pendingSince,
      nextAttemptAt: null,
      attempts: 1,
      leaseUntil: null,
      status: 'error',
      lastError: { code: 'NOT_FOUND', message: 'Alojamiento no encontrado', at: errorAt },
      lastSyncedAt: null,
    } satisfies AccommodationDoc);

    const body = await getStatusBody(service);

    expect(body).toEqual({
      accommodationId: ID,
      status: 'error',
      pendingDays: 3,
      pendingSince: pendingSince.toISOString(),
      pendingRanges: [{ from: day(3), to: day(5), available: false, pricePerNight: 90 }],
      attempts: 1,
      nextAttemptAt: null,
      lastError: { code: 'NOT_FOUND', message: 'Alojamiento no encontrado', at: errorAt.toISOString() },
      lastSyncedAt: null,
    });
  });

  it('los días pendientes anteriores a hoy no cuentan en pendingDays ni en pendingRanges', async () => {
    await post(service, { from: day(0), to: day(4), available: true, pricePerNight: 120 });

    advanceClock(2 * DAY_MS);
    const body = await getStatusBody(service);

    // Tras adelantar el reloj, day(0) es el nuevo "hoy": los dos primeros días ya han pasado.
    expect(body.pendingDays).toBe(3);
    expect(body.pendingRanges).toEqual([{ from: day(0), to: day(2), available: true, pricePerNight: 120 }]);
  });
});

describe('GET /accommodations/:id/sync-status con MongoDB parado', () => {
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

    const response = await getStatus(service);

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: { code?: unknown } };
    expect(body.error?.code).toBe('STORAGE_UNAVAILABLE');
  }, 15_000);
});
