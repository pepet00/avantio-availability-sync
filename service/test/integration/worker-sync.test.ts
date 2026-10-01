import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMs, advanceClock, now, resetClock } from '../../src/clock.js';
import { addDays, compareDays, daysInRange, enumerateDays, parseDay, todayUtc, type Day } from '../../src/dates.js';
import type { AccommodationDoc } from '../../src/storage/types.js';
import { MAX_RANGE_DAYS } from '../../src/sync/grouping.js';
import { ok, startFakePortal, type FakePortal, type FakeResponse } from '../helpers/fake-portal.js';
import { startTestMongo, type TestMongo } from '../helpers/mongo.js';
import { startService, type TestService } from '../helpers/service.js';
import { waitFor } from '../helpers/wait-for.js';

const ID = 'acc-1003';
const DAY_MS = 86_400_000;
const LEASE_MS = 60_000;

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

describe('worker: sincronización con el portal', () => {
  let mongo: TestMongo;
  let portal: FakePortal;
  let service: TestService;

  beforeAll(async () => {
    mongo = await startTestMongo();
    portal = await startFakePortal();
  }, 120_000);

  afterAll(async () => {
    await portal.close();
    await mongo.stop();
  });

  beforeEach(async () => {
    // Un "hoy" que no es el real: las fechas deben salir del reloj del servicio.
    advanceClock(400 * DAY_MS);
    portal.reset();
    service = await startService(mongo.freshUrl(), { portalUrl: portal.url, leaseMs: LEASE_MS }, { worker: true });
  });

  afterEach(async () => {
    // Corta las respuestas retenidas para que la parada no espere al timeout.
    portal.reset();
    await service.close();
    resetClock();
  });

  async function post(body: SentRange & { accommodationId?: string }): Promise<void> {
    const response = await fetch(`${service.url}/updates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accommodationId: ID, ...body }),
    });
    expect(response.status).toBe(202);
  }

  async function load(id = ID): Promise<AccommodationDoc> {
    const doc = await service.storage.accommodations.findOne({ _id: id });
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

  /** Rangos de los PUT que ha recibido el portal falso para un alojamiento, en orden. */
  function sentRanges(id = ID): SentRange[] {
    return portal.requests
      .filter((request) => request.method === 'PUT' && request.accommodationId === id)
      .map(({ body }) => {
        const { from, to, available, pricePerNight } = body as Record<string, unknown>;
        const fromDay = parseDay(String(from));
        const toDay = parseDay(String(to));
        if (fromDay === null || toDay === null || typeof available !== 'boolean' || typeof pricePerNight !== 'number') {
          throw new Error(`PUT con un cuerpo inesperado: ${JSON.stringify(body)}`);
        }
        return { from: fromDay, to: toDay, available, pricePerNight };
      });
  }

  function pendingDoc(id: string, leaseUntil: Date): AccommodationDoc {
    const at = now();
    return {
      _id: id,
      seq: 1,
      rev: 1,
      days: { [day(1)]: { available: true, price: 100, version: 1, syncedVersion: 0 } },
      pending: true,
      pendingSince: at,
      nextAttemptAt: at,
      attempts: 0,
      leaseUntil,
      status: 'pending',
      lastError: null,
      lastSyncedAt: null,
    };
  }

  it('CA-1: con dos updates solapados, el último PUT de cada día lleva los valores del último update', async () => {
    await post({ from: day(1), to: day(5), available: true, pricePerNight: 100 });
    await post({ from: day(3), to: day(7), available: false, pricePerNight: 150 });

    await waitSynced();

    const ranges = sentRanges();
    for (let offset = 1; offset <= 7; offset++) {
      const d = day(offset);
      const last = ranges.findLast((r) => compareDays(r.from, d) <= 0 && compareDays(d, r.to) <= 0);
      const expected = offset <= 2 ? { available: true, pricePerNight: 100 } : { available: false, pricePerNight: 150 };
      expect(last, d).toMatchObject(expected);
    }
  });

  it('CA-2: un update que llega con el PUT en camino deja el día pendiente y se reenvía con el valor nuevo', async () => {
    const first = Promise.withResolvers<FakeResponse>();
    const second = Promise.withResolvers<FakeResponse>();
    portal.enqueue(
      () => first.promise,
      () => second.promise,
    );

    await post({ from: day(1), to: day(3), available: true, pricePerNight: 100 });
    await waitFor(() => portal.requests.length === 1, { message: 'el primer PUT' });
    await post({ from: day(2), to: day(2), available: false, pricePerNight: 100 });
    first.resolve(ok());

    // Con el reenvío en camino: el 200 del primero solo confirmó los días que no cambiaron.
    await waitFor(() => portal.requests.length === 2, { message: 'el reenvío' });
    const { days } = await load();
    expect(days[day(1)]).toMatchObject({ version: 1, syncedVersion: 1 });
    expect(days[day(2)]).toMatchObject({ available: false, version: 2, syncedVersion: 0 });
    expect(days[day(3)]).toMatchObject({ version: 1, syncedVersion: 1 });
    expect(sentRanges()).toEqual([
      { from: day(1), to: day(3), available: true, pricePerNight: 100 },
      { from: day(2), to: day(2), available: false, pricePerNight: 100 },
    ]);

    second.resolve(ok());
    const doc = await waitSynced();
    expect(doc.days[day(2)]).toMatchObject({ version: 2, syncedVersion: 2 });
    expect(portal.requests).toHaveLength(2);
  });

  it('CA-7: un update de 90 días llega como tres PUT que cubren cada día una vez, ninguno de más de 31', async () => {
    await post({ from: day(1), to: day(90), available: true, pricePerNight: 80 });

    await waitSynced();

    const ranges = sentRanges();
    expect(ranges).toHaveLength(3);
    for (const range of ranges) {
      expect(daysInRange(range.from, range.to)).toBeLessThanOrEqual(MAX_RANGE_DAYS);
    }
    expect(ranges.flatMap((r) => enumerateDays(r.from, r.to))).toEqual(enumerateDays(day(1), day(90)));
  });

  it('al quedar sin pendientes: synced, sin pendientes ni siguiente intento, attempts 0, lastSyncedAt del 200 y lease liberado', async () => {
    await post({ from: day(1), to: day(2), available: true, pricePerNight: 100 });

    const doc = await waitSynced();

    expect(doc).toMatchObject({
      status: 'synced',
      pending: false,
      pendingSince: null,
      nextAttemptAt: null,
      attempts: 0,
      lastError: null,
      leaseUntil: null,
    });
    const [request] = portal.requests;
    expect(request?.status).toBe(200);
    expect(doc.lastSyncedAt?.getTime()).toBeGreaterThanOrEqual(request?.at.getTime() ?? Infinity);
    expect(doc.lastSyncedAt?.getTime()).toBeLessThanOrEqual(now().getTime());
  });

  it('un día cuyos valores no cambian no se reenvía', async () => {
    await post({ from: day(1), to: day(5), available: true, pricePerNight: 100 });
    await waitSynced();

    await post({ from: day(3), to: day(7), available: true, pricePerNight: 100 });
    await waitSynced();

    expect(sentRanges()).toEqual([
      { from: day(1), to: day(5), available: true, pricePerNight: 100 },
      { from: day(6), to: day(7), available: true, pricePerNight: 100 },
    ]);
  });

  describe('lease', () => {
    it('un alojamiento con lease activo no se coge', async () => {
      await service.storage.accommodations.insertOne(pendingDoc('acc-reservado', addMs(now(), LEASE_MS)));

      // Otro alojamiento, más reciente, se sincroniza: el worker ha pasado por delante del reservado.
      await post({ accommodationId: 'acc-libre', from: day(1), to: day(1), available: true, pricePerNight: 100 });
      await waitSynced('acc-libre');

      expect(sentRanges('acc-reservado')).toEqual([]);
      expect((await load('acc-reservado')).status).toBe('pending');
    });

    it('uno con lease caducado se retoma y se registra worker.lease_expired', async () => {
      const expired = addMs(now(), -1_000);
      await service.storage.accommodations.insertOne(pendingDoc('acc-caducado', expired));

      await waitSynced('acc-caducado');

      expect(sentRanges('acc-caducado')).toEqual([
        { from: day(1), to: day(1), available: true, pricePerNight: 100 },
      ]);
      expect(service.logs.events('worker.lease_expired')).toEqual([
        expect.objectContaining({ level: 40, accommodationId: 'acc-caducado', leaseUntil: expired.toISOString() }),
      ]);
    });

    it('el lease se renueva antes de cada PUT', async () => {
      const seen: { at: Date; leaseUntil: Date | null }[] = [];
      portal.setDefault(async (request) => {
        seen.push({ at: request.at, leaseUntil: (await load()).leaseUntil });
        // El primer PUT "tarda" 30 s: sin renovar, el lease del segundo seguiría siendo el de la reserva.
        if (seen.length === 1) advanceClock(30_000);
        return ok();
      });

      // 32 días iguales: dos PUT.
      await post({ from: day(1), to: day(32), available: true, pricePerNight: 100 });
      await waitSynced();

      expect(seen).toHaveLength(2);
      for (const { at, leaseUntil } of seen) {
        // Renovado justo antes de llegar este PUT: caduca un lease después de su llegada.
        expect(leaseUntil?.getTime()).toBeGreaterThan(at.getTime() + LEASE_MS - 1_000);
        expect(leaseUntil?.getTime()).toBeLessThanOrEqual(at.getTime() + LEASE_MS);
      }
    });

    it('las escrituras de lease no tocan rev; las de estado lo suben', async () => {
      const seen: { rev: number; leaseUntil: Date | null }[] = [];
      portal.setDefault(async () => {
        const { rev, leaseUntil } = await load();
        seen.push({ rev, leaseUntil });
        return ok();
      });

      // El POST crea el documento con rev 1; 32 días iguales: dos PUT.
      await post({ from: day(1), to: day(32), available: true, pricePerNight: 100 });
      const doc = await waitSynced();

      // Reservar y renovar (lease) antes de cada PUT no la suben; cada confirmación (estado), sí.
      expect(seen.map((s) => s.rev)).toEqual([1, 2]);
      expect(seen.every((s) => s.leaseUntil !== null)).toBe(true);
      // Liberar el lease tampoco: dos confirmaciones sobre el rev 1 del POST.
      expect(doc.rev).toBe(3);
    });
  });
});
