import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMs, advanceClock, now, resetClock } from '../../src/clock.js';
import { addDays, todayUtc, type Day } from '../../src/dates.js';
import { connectStorage, type Storage } from '../../src/storage/mongo.js';
import { AccommodationRepository } from '../../src/storage/repository.js';
import type { AccommodationDoc } from '../../src/storage/types.js';
import type { AccommodationUpdate, UpdateConfig } from '../../src/sync/state.js';
import { startTestMongo, type TestMongo } from '../helpers/mongo.js';

const config: UpdateConfig = { timeoutGraceMs: 30_000 };
const ID = 'acc-1003';

let mongo: TestMongo;
let storage: Storage;
let repository: AccommodationRepository;

beforeAll(async () => {
  mongo = await startTestMongo();
}, 120_000);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  storage = await connectStorage(mongo.freshUrl());
  repository = new AccommodationRepository(storage.accommodations);
});

afterEach(async () => {
  resetClock();
  await storage.close();
});

/** Día relativo a "hoy" según el reloj controlado. */
function day(offset: number): Day {
  return addDays(todayUtc(now()), offset);
}

function update(from: number, to: number, available: boolean, pricePerNight: number): AccommodationUpdate {
  return { accommodationId: ID, from: day(from), to: day(to), available, pricePerNight };
}

async function load(): Promise<AccommodationDoc> {
  const doc = await repository.findById(ID);
  if (doc === null) throw new Error(`No existe el documento ${ID}`);
  return doc;
}

/** Aplica el update y devuelve el intervalo de reloj en que ocurrió, para comprobar "= ahora". */
async function applyTimed(u: AccommodationUpdate): Promise<{ before: Date; after: Date }> {
  const before = now();
  await repository.applyUpdate(u, config);
  return { before, after: now() };
}

function expectWithin(value: Date | null, { before, after }: { before: Date; after: Date }): void {
  expect(value).toBeInstanceOf(Date);
  expect(value?.getTime()).toBeGreaterThanOrEqual(before.getTime());
  expect(value?.getTime()).toBeLessThanOrEqual(after.getTime());
}

/**
 * Siembra un alojamiento con un día de mañana ya sincronizado (libre a 100) y, si `pendingDay`,
 * otro pasado mañana pendiente. Las sobrescrituras fijan el estado de reintento.
 */
async function seed(overrides: Partial<AccommodationDoc>, pendingDay = true): Promise<AccommodationDoc> {
  const doc: AccommodationDoc = {
    _id: ID,
    seq: 2,
    rev: 5,
    days: {
      [day(1)]: { available: true, price: 100, version: 1, syncedVersion: 1 },
      ...(pendingDay ? { [day(2)]: { available: true, price: 100, version: 2, syncedVersion: 0 } } : {}),
    },
    pending: pendingDay,
    pendingSince: pendingDay ? addMs(now(), -600_000) : null,
    nextAttemptAt: pendingDay ? addMs(now(), 60_000) : null,
    attempts: 0,
    leaseUntil: null,
    status: pendingDay ? 'pending' : 'synced',
    lastError: null,
    lastSyncedAt: addMs(now(), -900_000),
    ...overrides,
  };
  await storage.accommodations.insertOne(doc);
  return doc;
}

describe('aplicar un update', () => {
  it('el primer update crea el documento con todos los días pendientes', async () => {
    const timing = await applyTimed(update(0, 2, true, 120));

    const doc = await load();
    expect(doc).toMatchObject({
      seq: 1,
      rev: 1,
      pending: true,
      attempts: 0,
      status: 'pending',
      leaseUntil: null,
      lastError: null,
      lastSyncedAt: null,
    });
    expect(doc.days).toEqual({
      [day(0)]: { available: true, price: 120, version: 1, syncedVersion: 0 },
      [day(1)]: { available: true, price: 120, version: 1, syncedVersion: 0 },
      [day(2)]: { available: true, price: 120, version: 1, syncedVersion: 0 },
    });
    expectWithin(doc.pendingSince, timing);
    expectWithin(doc.nextAttemptAt, timing);
  });

  it('un segundo update solapado sube seq y rev y solo cambia la versión de los días que cambian', async () => {
    await repository.applyUpdate(update(0, 3, true, 120), config);
    const first = await load();
    advanceClock(60_000);

    // Días 2-3 iguales; días 4-5 nuevos; el día 3 cambia de precio en un tercer update.
    await repository.applyUpdate(update(2, 5, true, 120), config);
    await repository.applyUpdate(update(3, 3, true, 150), config);

    const doc = await load();
    expect(doc.seq).toBe(3);
    expect(doc.rev).toBe(3);
    expect(doc.days).toEqual({
      [day(0)]: { available: true, price: 120, version: 1, syncedVersion: 0 },
      [day(1)]: { available: true, price: 120, version: 1, syncedVersion: 0 },
      [day(2)]: { available: true, price: 120, version: 1, syncedVersion: 0 },
      [day(3)]: { available: true, price: 150, version: 3, syncedVersion: 0 },
      [day(4)]: { available: true, price: 120, version: 2, syncedVersion: 0 },
      [day(5)]: { available: true, price: 120, version: 2, syncedVersion: 0 },
    });
    expect(doc.pendingSince).toEqual(first.pendingSince);
  });

  it('un update con los mismos valores sobre un alojamiento synced no lo deja pendiente', async () => {
    const seeded = await seed({}, false);

    await repository.applyUpdate(update(1, 1, true, 100), config);

    const doc = await load();
    expect(doc).toMatchObject({
      seq: seeded.seq + 1,
      rev: seeded.rev + 1,
      days: seeded.days,
      pending: false,
      pendingSince: null,
      nextAttemptAt: null,
      status: 'synced',
    });
  });

  it('un update con los mismos valores sobre un alojamiento en error lo devuelve a pending', async () => {
    const seeded = await seed({
      status: 'error',
      attempts: 1,
      nextAttemptAt: null,
      lastError: { code: 'NOT_FOUND', message: 'Alojamiento inexistente', at: addMs(now(), -60_000) },
    });

    const timing = await applyTimed(update(1, 2, true, 100));

    const doc = await load();
    expect(doc).toMatchObject({ seq: seeded.seq + 1, days: seeded.days, status: 'pending', attempts: 0, pending: true });
    expectWithin(doc.nextAttemptAt, timing);
  });

  it('N updates simultáneos sobre el mismo alojamiento se aplican todos', async () => {
    const n = 20;
    await Promise.all(Array.from({ length: n }, (_, i) => repository.applyUpdate(update(i, i, i % 2 === 0, 100 + i), config)));

    const doc = await load();
    expect(doc.seq).toBe(n);
    expect(doc.rev).toBe(n);
    expect(Object.keys(doc.days)).toHaveLength(n);
    for (let i = 0; i < n; i++) {
      expect(doc.days[day(i)]).toMatchObject({ available: i % 2 === 0, price: 100 + i, syncedVersion: 0 });
    }
    // Cada update dejó su propia versión: ninguno se aplicó sobre un estado que no había leído.
    const versions = Object.values(doc.days).map((d) => d.version).sort((a, b) => a - b);
    expect(versions).toEqual(Array.from({ length: n }, (_, i) => i + 1));
  });

  it('existen los tres índices de la SPEC', async () => {
    const indexes = await storage.accommodations.indexes();
    const keys = indexes.map((index) => index.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        { pending: 1, nextAttemptAt: 1 },
        { status: 1 },
        { pending: 1, pendingSince: 1 },
      ]),
    );
  });
});

describe('efecto sobre un alojamiento en reintento', () => {
  it('en error vuelve a pending con attempts 0 y nextAttemptAt = ahora', async () => {
    await seed({
      status: 'error',
      attempts: 1,
      nextAttemptAt: null,
      lastError: { code: 'NOT_FOUND', message: 'Alojamiento inexistente', at: addMs(now(), -60_000) },
    });

    const timing = await applyTimed(update(3, 3, false, 90));

    const doc = await load();
    expect(doc).toMatchObject({ status: 'pending', attempts: 0, pending: true });
    expectWithin(doc.nextAttemptAt, timing);
  });

  it('esperando por 5xx o 401 se adelanta el reintento a ahora', async () => {
    for (const code of ['UNAVAILABLE', 'UNAUTHORIZED']) {
      await storage.accommodations.deleteMany({});
      await seed({
        attempts: 2,
        nextAttemptAt: addMs(now(), 120_000),
        lastError: { code, message: 'Fallo del portal', at: addMs(now(), -1_000) },
      });

      const timing = await applyTimed(update(3, 3, false, 90));

      const doc = await load();
      expect(doc).toMatchObject({ status: 'pending', attempts: 2 });
      expectWithin(doc.nextAttemptAt, timing);
    }
  });

  it('en failing no se adelanta el reintento', async () => {
    const seeded = await seed({
      status: 'failing',
      attempts: 5,
      nextAttemptAt: addMs(now(), 120_000),
      lastError: { code: 'UNAVAILABLE', message: 'Fallo del portal', at: addMs(now(), -1_000) },
    });

    await repository.applyUpdate(update(3, 3, false, 90), config);

    const doc = await load();
    expect(doc).toMatchObject({ status: 'failing', attempts: 5, nextAttemptAt: seeded.nextAttemptAt });
  });

  it('tras timeout o error de conexión queda en max(ahora, lastError.at + margen)', async () => {
    // Timeout reciente: el margen aún no ha pasado y manda sobre un backoff más largo.
    const recent = addMs(now(), -5_000);
    await seed({
      attempts: 1,
      nextAttemptAt: addMs(now(), 120_000),
      lastError: { code: 'TIMEOUT', message: 'Sin respuesta tras 15 s', at: recent },
    });
    await repository.applyUpdate(update(3, 3, false, 90), config);
    expect((await load()).nextAttemptAt).toEqual(addMs(recent, config.timeoutGraceMs));

    // Error de conexión antiguo: el margen ya pasó y el reintento queda en ahora.
    await storage.accommodations.deleteMany({});
    await seed({
      attempts: 3,
      nextAttemptAt: addMs(now(), 120_000),
      lastError: { code: 'CONNECTION_ERROR', message: 'Conexión rechazada', at: addMs(now(), -60_000) },
    });
    const timing = await applyTimed(update(3, 3, false, 90));
    expectWithin((await load()).nextAttemptAt, timing);
  });
});
