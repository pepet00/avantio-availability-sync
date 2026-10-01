import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { advanceClock, now, resetClock } from '../../src/clock.js';
import { addDays, todayUtc, type Day } from '../../src/dates.js';
import { ACCOMMODATIONS_COLLECTION } from '../../src/storage/mongo.js';
import { startTestMongo, type TestMongo } from '../helpers/mongo.js';
import { startService, type TestService } from '../helpers/service.js';

const ID = 'acc-1003';

/** Día relativo a "hoy" según el reloj controlado. */
function day(offset: number): Day {
  return addDays(todayUtc(now()), offset);
}

function update(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { accommodationId: ID, from: day(1), to: day(7), available: true, pricePerNight: 120, ...overrides };
}

async function post(service: TestService, body: unknown): Promise<Response> {
  return fetch(`${service.url}/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Comprueba el código HTTP y la forma `{ error: { code, message } }`; devuelve el cuerpo en texto. */
async function expectError(response: Response, status: number, code: string): Promise<string> {
  expect(response.status).toBe(status);
  const text = await response.text();
  const body = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
  expect(Object.keys(body)).toEqual(['error']);
  expect(Object.keys(body.error ?? {})).toEqual(['code', 'message']);
  expect(body.error?.code).toBe(code);
  expect(typeof body.error?.message).toBe('string');
  return text;
}

describe('POST /updates', () => {
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
    advanceClock(400 * 86_400_000);
    service = await startService(mongo.freshUrl());
  });

  afterEach(async () => {
    resetClock();
    await service.close();
  });

  it('un update válido devuelve 202 y ya está en MongoDB al recibir la respuesta', async () => {
    const response = await post(service, update());

    expect(response.status).toBe(202);
    const { updateId, ...body } = (await response.json()) as Record<string, unknown>;
    expect(typeof updateId).toBe('string');
    expect(body).toEqual({ accommodationId: ID, from: day(1), to: day(7), days: 7 });

    // Sin esperar: el 202 implica que el cambio está escrito (invariante 1).
    const doc = await service.storage.accommodations.findOne({ _id: ID });
    expect(doc?.seq).toBe(1);
    expect(Object.keys(doc?.days ?? {})).toHaveLength(7);

    expect(service.logs.events('update.accepted')).toEqual([
      expect.objectContaining({
        updateId,
        accommodationId: ID,
        from: day(1),
        to: day(7),
        available: true,
        pricePerNight: 120,
        days: 7,
      }),
    ]);
  });

  it.each([
    ['INVALID_BODY', 'un campo de más', () => update({ extra: true })],
    ['INVALID_BODY', 'un precio negativo', () => update({ pricePerNight: -1 })],
    ['INVALID_BODY', 'un accommodationId con espacios en los extremos', () => update({ accommodationId: ' acc-1003' })],
    // El 30 de febrero del año siguiente, hasta el 31 de diciembre: futuro y con to posterior,
    // así que solo falla por no existir.
    ['INVALID_DATE', 'el 30 de febrero', () => {
      const nextYear = String(Number(day(0).slice(0, 4)) + 1);
      return update({ from: `${nextYear}-02-30`, to: `${nextYear}-12-31` });
    }],
    ['INVALID_DATE', 'to anterior a from', () => update({ from: day(2), to: day(1) })],
    ['DATE_IN_PAST', 'from ayer', () => update({ from: day(-1) })],
    ['RANGE_TOO_LARGE', '366 días', () => update({ from: day(0), to: day(365) })],
  ])('%s por HTTP con %s', async (code, _case, build) => {
    const response = await post(service, build());

    await expectError(response, 400, code);
    expect(await service.storage.accommodations.countDocuments()).toBe(0);
    expect(service.logs.events('update.rejected')).toEqual([expect.objectContaining({ errorCode: code })]);
  });

  it('JSON mal formado → 400 INVALID_BODY', async () => {
    const response = await fetch(`${service.url}/updates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"accommodationId": "acc-1003",',
    });

    await expectError(response, 400, 'INVALID_BODY');
    expect(service.logs.events('update.rejected')).toEqual([expect.objectContaining({ errorCode: 'INVALID_BODY' })]);
  });

  it.each([
    ['sin Content-Type', {}],
    ['con Content-Type: text/plain', { 'Content-Type': 'text/plain' }],
  ])('%s → 400 INVALID_BODY', async (_case, headers) => {
    const response = await fetch(`${service.url}/updates`, {
      method: 'POST',
      headers,
      // Bytes y no texto: con texto, fetch añadiría Content-Type: text/plain.
      body: new TextEncoder().encode(JSON.stringify(update())),
    });

    await expectError(response, 400, 'INVALID_BODY');
    expect(await service.storage.accommodations.countDocuments()).toBe(0);
  });

  it('ruta inexistente → 404 NOT_FOUND', async () => {
    const response = await fetch(`${service.url}/no-existe`);

    await expectError(response, 404, 'NOT_FOUND');
  });

  it('un fallo inesperado → 500 INTERNAL_ERROR sin detalles internos', async () => {
    // MongoDB responde, pero rechaza todo documento: un error que no es de disponibilidad.
    await service.storage.client.db().command({
      collMod: ACCOMMODATIONS_COLLECTION,
      validator: { seq: { $lt: 0 } },
      validationAction: 'error',
    });

    const response = await post(service, update());

    const body = await expectError(response, 500, 'INTERNAL_ERROR');
    expect(body).not.toMatch(/validation|mongo|seq/i);
  });
});

describe('POST /updates con MongoDB parado', () => {
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

  it('responde 503 STORAGE_UNAVAILABLE y ningún 202', async () => {
    await mongo.stop();

    const response = await post(service, update());

    await expectError(response, 503, 'STORAGE_UNAVAILABLE');
    expect(service.logs.events('update.accepted')).toEqual([]);
  }, 15_000);
});
