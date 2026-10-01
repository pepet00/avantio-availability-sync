import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMs, advanceClock, now, resetClock } from '../../src/clock.js';
import { addDays, todayUtc, type Day } from '../../src/dates.js';
import type { AccommodationDoc } from '../../src/storage/types.js';
import { ok, startFakePortal, type FakePortal, type FakeResponse } from '../helpers/fake-portal.js';
import { startTestMongo, type TestMongo } from '../helpers/mongo.js';
import { startService, type TestService } from '../helpers/service.js';
import { waitFor } from '../helpers/wait-for.js';

const ID = 'acc-1003';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Día relativo a "hoy" según el reloj controlado. */
function day(offset: number): Day {
  return addDays(todayUtc(now()), offset);
}

describe('arranque y barrido de días pasados', () => {
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
    // Corta las respuestas retenidas para que la parada no espere al timeout.
    portal.reset();
    for (const service of services) await service.close();
    services = [];
    resetClock();
  });

  async function start(mongoUrl: string, worker: boolean): Promise<TestService> {
    const service = await startService(mongoUrl, { portalUrl: portal.url }, { worker });
    services.push(service);
    return service;
  }

  async function stop(service: TestService): Promise<void> {
    services = services.filter((s) => s !== service);
    await service.close();
  }

  async function post(service: TestService, accommodationId: string, from: Day, to: Day, price = 100): Promise<void> {
    const response = await fetch(`${service.url}/updates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accommodationId, from, to, available: true, pricePerNight: price }),
    });
    expect(response.status).toBe(202);
  }

  async function load(service: TestService, id = ID): Promise<AccommodationDoc> {
    const doc = await service.storage.accommodations.findOne({ _id: id });
    if (doc === null) throw new Error(`No existe el documento de ${id}`);
    return doc;
  }

  /** Espera a que el alojamiento tenga ese estado y el lease esté liberado. */
  function waitStatus(service: TestService, status: AccommodationDoc['status'], id = ID): Promise<AccommodationDoc> {
    return waitFor(
      async () => {
        const doc = await load(service, id);
        return doc.status === status && doc.leaseUntil === null ? doc : null;
      },
      { message: `que ${id} quede ${status}` },
    );
  }

  async function errorGauge(service: TestService): Promise<number> {
    const response = await fetch(`${service.url}/metrics`);
    expect(response.status).toBe(200);
    const match = /^sync_accommodations_by_status\{status="error"\} (\S+)$/m.exec(await response.text());
    if (match === null) throw new Error('Falta sync_accommodations_by_status{status="error"}');
    return Number(match[1]);
  }

  /** Lleva `ID` a `error` con un `404` del portal sobre `[from, to]`. */
  async function postUntilError(service: TestService, from: Day, to: Day): Promise<void> {
    portal.setDefault((request) => (request.accommodationId === ID ? { status: 404 } : ok()));
    await post(service, ID, from, to);
    await waitStatus(service, 'error');
    portal.reset();
  }

  it('CA-6: tras un reinicio con updates pendientes, incluido uno con un lease vivo de un proceso muerto, todos se sincronizan', async () => {
    const mongoUrl = mongo.freshUrl();
    const ids = ['acc-1', 'acc-2', 'acc-3'];
    const first = await start(mongoUrl, false);
    for (const id of ids) await post(first, id, day(1), day(3));
    // El proceso "muerto" tenía reservado acc-2 durante una hora más.
    await first.storage.accommodations.updateOne({ _id: 'acc-2' }, { $set: { leaseUntil: addMs(now(), HOUR_MS) } });
    await stop(first);

    const second = await start(mongoUrl, true);
    for (const id of ids) await waitStatus(second, 'synced', id);

    const sent = portal.requests.filter((request) => request.method === 'PUT').map((r) => r.accommodationId);
    expect(sent.sort()).toEqual(ids);
    // Se cogió por el reset al arrancar, no porque el lease caducara.
    expect(second.logs.events('worker.lease_expired')).toEqual([]);
  });

  it('CA-11: un alojamiento en error cuyos días pendientes han pasado queda synced al cambiar de día y deja de contar en las métricas', async () => {
    const service = await start(mongo.freshUrl(), true);
    await postUntilError(service, day(0), day(1));
    expect(await errorGauge(service)).toBe(1);

    advanceClock(2 * DAY_MS);
    const doc = await waitStatus(service, 'synced');

    expect(doc).toMatchObject({ pending: false, pendingSince: null, nextAttemptAt: null, attempts: 0, lastError: null });
    expect(await errorGauge(service)).toBe(0);
    // Barrido al arrancar (nada que revisar) y otro con el servicio en marcha, al cambiar de día.
    expect(service.logs.events('sweep.completed')).toEqual([
      expect.objectContaining({ level: 30, reviewed: 0, settled: 0 }),
      expect.objectContaining({ level: 30, reviewed: 1, settled: 1 }),
    ]);
    // Nada más se envía al portal: los días ya han pasado.
    expect(portal.requests).toEqual([]);
  });

  it('el barrido se ejecuta al arrancar: un error con días pasados queda synced desde la primera consulta, sin borrar los días', async () => {
    const mongoUrl = mongo.freshUrl();
    const first = await start(mongoUrl, true);
    await postUntilError(first, day(0), day(1));
    const before = await load(first);
    await stop(first);

    advanceClock(2 * DAY_MS);
    const second = await start(mongoUrl, false);

    expect(await errorGauge(second)).toBe(0);
    const after = await load(second);
    expect(after).toMatchObject({ status: 'synced', pending: false, rev: before.rev + 1 });
    // Los días pasados siguen en el documento, sin marcarse sincronizados.
    expect(after.days).toEqual(before.days);
    expect(second.logs.events('sweep.completed')).toEqual([
      expect.objectContaining({ level: 30, reviewed: 1, settled: 1 }),
    ]);
  });

  it('un alojamiento con días pendientes pasados y futuros sigue pending y solo se envían los futuros', async () => {
    const mongoUrl = mongo.freshUrl();
    const first = await start(mongoUrl, false);
    await post(first, ID, day(0), day(3));
    await stop(first);

    advanceClock(2 * DAY_MS);
    const held = Promise.withResolvers<FakeResponse>();
    portal.enqueue(() => held.promise);
    const second = await start(mongoUrl, true);

    await waitFor(() => portal.requests.length === 1, { message: 'el PUT de los días futuros' });
    expect(portal.requests[0]?.body).toEqual({ from: day(0), to: day(1), available: true, pricePerNight: 100 });
    expect(await load(second)).toMatchObject({ status: 'pending', pending: true });
    expect(second.logs.events('sweep.completed')).toEqual([
      expect.objectContaining({ reviewed: 1, settled: 0 }),
    ]);

    held.resolve(ok());
    const doc = await waitStatus(second, 'synced');
    expect(portal.requests).toHaveLength(1);
    // Los dos días pasados siguen en el documento.
    expect(Object.keys(doc.days)).toHaveLength(4);
  });
});
