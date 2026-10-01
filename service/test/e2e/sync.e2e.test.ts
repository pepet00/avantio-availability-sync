// E2E contra el Portal Sol real (docker compose --profile mongo up -d). Sigue los cinco pasos de la
// SPEC: el servicio arranca en este proceso, contra el MongoDB del compose, con el limitador por
// encima del límite del portal para provocar `429` y comprobar que se respetan.
// El portal falla y tarda al azar: el test es lento y no comprueba cuántos reintentos hubo.

import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { now } from '../../src/clock.js';
import { loadConfig, type Config } from '../../src/config.js';
import { addDays, daysInRange, enumerateDays, parseDay, todayUtc, type Day } from '../../src/dates.js';
import { MAX_RANGE_DAYS } from '../../src/sync/grouping.js';
import { startService, type TestService } from '../helpers/service.js';
import { waitFor } from '../helpers/wait-for.js';

/** Base propia del E2E, para no tocar la de `npm run dev` (`sync`). Se borra al empezar. */
const MONGO_URL = 'mongodb://localhost:27017/sync-e2e';
const DEFAULTS = loadConfig({});
const PORTAL_URL = DEFAULTS.portalUrl;
const API_KEY = DEFAULTS.portalApiKey;
/** Por encima de las 30 peticiones por minuto del portal: el portal acabará respondiendo `429`. */
const RATE_LIMIT_ABOVE_PORTAL = 45;
const SYNC_TIMEOUT_MS = 8 * 60_000;

interface Update {
  accommodationId: string;
  from: Day;
  to: Day;
  available: boolean;
  pricePerNight: number;
}

interface DayValue {
  available: boolean;
  pricePerNight: number;
}

/** Entrada de `GET /__admin/requests`. */
interface PortalRequest {
  id: number;
  timestamp: string;
  method: string;
  path: string;
  body: { from: string; to: string; available: boolean; pricePerNight: number } | null;
  status: number | null;
}

/** Día relativo al "hoy" real. Desde mañana, para que un cambio de día durante el test no deje `from` en el pasado. */
function day(offset: number): Day {
  return addDays(todayUtc(now()), offset);
}

function range(accommodationId: string, from: number, to: number, available: boolean, pricePerNight: number): Update {
  return { accommodationId, from: day(from), to: day(to), available, pricePerNight };
}

/** Alojamiento con un update de 90 días y nada más: sus PUT dependen solo de la agrupación. */
const LONG_ID = 'acc-1001';
const LONG_UPDATE = range(LONG_ID, 1, 90, false, 99);

/** Updates de cada alojamiento, en el orden en que se envían. */
function buildUpdates(): Update[][] {
  // Solapados: el portal debe acabar con los valores del último de cada día (CA-1).
  const overlapping = ['acc-1002', 'acc-1003', 'acc-1004'].map((id, k) => [
    range(id, 1, 20, true, 100 + k),
    range(id, 10, 30, false, 150 + k),
    range(id, 5, 12, true, 175 + k),
  ]);
  // Días sueltos con huecos: un PUT por día. En total, más de 70 PUT, más de dos ventanas del portal:
  // aunque las respuestas lentas impidan pasar de 30 en el primer minuto, alguna ventana lo hará (`429`).
  const scattered = ['acc-1005', 'acc-1006', 'acc-1007', 'acc-1008', 'acc-1009', 'acc-1010'].map((id, k) =>
    Array.from({ length: 10 }, (_, i) => range(id, 1 + 2 * i, 1 + 2 * i, i % 2 === 0, 60 + 10 * k + i)),
  );
  return [[LONG_UPDATE], ...overlapping, ...scattered];
}

/** Estado esperado en el portal: cada update pisa a los anteriores en sus días. */
function expectedState(updates: Update[][]): Map<string, Map<Day, DayValue>> {
  const state = new Map<string, Map<Day, DayValue>>();
  for (const update of updates.flat()) {
    const days = state.get(update.accommodationId) ?? new Map<Day, DayValue>();
    for (const d of enumerateDays(update.from, update.to)) {
      days.set(d, { available: update.available, pricePerNight: update.pricePerNight });
    }
    state.set(update.accommodationId, days);
  }
  return state;
}

/**
 * GET del test al portal. Gasta del mismo contador que los PUT del servicio, así que puede recibir
 * `429` (se espera su `Retry-After`) o `503` (se reintenta); no pasa por el cliente del servicio.
 */
async function portalGet(path: string): Promise<unknown> {
  for (let attempt = 1; attempt <= 20; attempt++) {
    const response = await fetch(`${PORTAL_URL}${path}`, { headers: { 'X-Api-Key': API_KEY } });
    if (response.status === 200) return response.json();
    await response.body?.cancel();
    if (response.status !== 429 && response.status !== 503) {
      throw new Error(`GET ${path} respondió ${String(response.status)}`);
    }
    // El portal envía `Retry-After` en segundos (API.md). Si llegara como fecha HTTP daría NaN y se
    // esperaría 1 s: basta para este test, que no pasa por el cliente del servicio.
    const retryAfterS = Number(response.headers.get('retry-after') ?? '1');
    const waitMs = response.status === 429 && Number.isFinite(retryAfterS) ? retryAfterS * 1000 : 1000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw new Error(`GET ${path} no respondió 200 tras 20 intentos`);
}

async function adminRequests(): Promise<PortalRequest[]> {
  const response = await fetch(`${PORTAL_URL}/__admin/requests`);
  expect(response.status).toBe(200);
  const json = (await response.json()) as { requests: PortalRequest[] };
  return json.requests;
}

function accommodationOf(request: PortalRequest): string {
  const match = /^\/api\/v1\/accommodations\/([^/]+)\/availability$/.exec(request.path);
  if (match?.[1] === undefined) throw new Error(`Ruta de PUT inesperada: ${request.path}`);
  return decodeURIComponent(match[1]);
}

describe('E2E contra Portal Sol', () => {
  let service: TestService;
  const updates = buildUpdates();
  const ids = updates.map((list) => list[0]?.accommodationId ?? '');

  beforeAll(async () => {
    const health = await fetch(`${PORTAL_URL}/health`).catch(() => null);
    if (health?.status !== 200) {
      throw new Error(`Portal Sol no responde en ${PORTAL_URL}: levanta "docker compose --profile mongo up -d"`);
    }

    // 1. Portal reiniciado (datos, registro y contador por minuto) y base del servicio limpia.
    const reset = await fetch(`${PORTAL_URL}/__admin/reset`, { method: 'POST' });
    expect(reset.status).toBe(200);
    const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 5_000 });
    try {
      await client.db().dropDatabase();
    } finally {
      await client.close();
    }

    // 2. Servicio con los tiempos de la SPEC (el portal real tarda hasta ~10 s) y el limitador
    // por encima del límite del portal.
    const timings: Partial<Config> = {
      portalTimeoutMs: DEFAULTS.portalTimeoutMs,
      timeoutGraceMs: DEFAULTS.timeoutGraceMs,
      backoffBaseMs: DEFAULTS.backoffBaseMs,
      backoffMaxMs: DEFAULTS.backoffMaxMs,
      workerIdleMs: DEFAULTS.workerIdleMs,
    };
    service = await startService(
      MONGO_URL,
      { ...timings, portalUrl: PORTAL_URL, portalApiKey: API_KEY, portalRateLimit: RATE_LIMIT_ABOVE_PORTAL },
      { worker: true },
    );
  }, 60_000);

  afterAll(async () => {
    await service.close();
  }, 60_000);

  it('sincroniza una ráfaga de updates solapados respetando los 31 días y los 429', async () => {
    // 2. Ráfaga: los alojamientos a la vez; los updates de cada uno, en orden, para que "el último" esté definido.
    await Promise.all(
      updates.map(async (list) => {
        for (const update of list) {
          const response = await fetch(`${service.url}/updates`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(update),
          });
          expect(response.status).toBe(202);
        }
      }),
    );

    // 3. Todos en `synced`. Un alojamiento en `error` ya no se reintenta: se falla en el acto, con el motivo.
    const outcome = await waitFor(
      async () => {
        for (const id of ids) {
          const response = await fetch(`${service.url}/accommodations/${encodeURIComponent(id)}/sync-status`);
          const status = (await response.json()) as {
            status: string;
            lastError: { code: string; message: string } | null;
          };
          if (status.status === 'error') {
            return { error: `${id} en error: ${status.lastError?.code ?? '?'} ${status.lastError?.message ?? ''}` };
          }
          if (status.status !== 'synced') return false;
        }
        return { error: null };
      },
      { timeoutMs: SYNC_TIMEOUT_MS, intervalMs: 1_000, message: 'que todos los alojamientos queden synced' },
    );
    if (outcome.error !== null) throw new Error(outcome.error);

    // 4. CA-1 y CA-3: el portal tiene los valores del último update de cada día.
    for (const [id, expectedDays] of expectedState(updates)) {
      const sorted = [...expectedDays.keys()].sort();
      const from = sorted[0] ?? '';
      const to = sorted[sorted.length - 1] ?? '';
      const json = (await portalGet(`/api/v1/accommodations/${encodeURIComponent(id)}?from=${from}&to=${to}`)) as {
        days: { date: string; available: boolean; pricePerNight: number }[];
      };
      const actual = new Map(json.days.map((d) => [d.date, { available: d.available, pricePerNight: d.pricePerNight }]));
      for (const [d, value] of expectedDays) {
        expect(actual.get(d), `${id} el ${d}`).toEqual(value);
      }
    }

    // 5. CA-3 y CA-4, sobre el registro del portal.
    const puts = (await adminRequests()).filter((request) => request.method === 'PUT');

    // CA-3: ningún PUT de más de 31 días; el update de 90 días son exactamente tres PUT.
    for (const put of puts) {
      const from = parseDay(put.body?.from ?? '');
      const to = parseDay(put.body?.to ?? '');
      expect(from, `PUT ${String(put.id)} con fecha inválida`).not.toBeNull();
      expect(to, `PUT ${String(put.id)} con fecha inválida`).not.toBeNull();
      if (from !== null && to !== null) expect(daysInRange(from, to)).toBeLessThanOrEqual(MAX_RANGE_DAYS);
    }
    const longPuts = puts.filter((put) => accommodationOf(put) === LONG_ID);
    // Los reintentos (`503`, `429`) repiten rango: se comparan los rangos distintos y los `200`.
    const longRanges = new Set(longPuts.map((put) => `${put.body?.from ?? ''}..${put.body?.to ?? ''}`));
    // Desde el `from` enviado, no desde el "hoy" de ahora: el test puede cruzar la medianoche UTC.
    const longFrom = LONG_UPDATE.from;
    expect([...longRanges].sort()).toEqual(
      [
        `${longFrom}..${addDays(longFrom, 30)}`,
        `${addDays(longFrom, 31)}..${addDays(longFrom, 61)}`,
        `${addDays(longFrom, 62)}..${LONG_UPDATE.to}`,
      ].sort(),
    );
    expect(longPuts.filter((put) => put.status === 200)).toHaveLength(3);

    // CA-4: cada PUT con `429` se empareja en orden con su `portal.rate_limited` (el registro del
    // portal no guarda el `Retry-After`) y no llega ningún PUT antes de que pase la pausa.
    // Ambos extremos se miden con el reloj del portal.
    const rateLimited = puts.filter((put) => put.status === 429);
    const events = service.logs.events('portal.rate_limited');
    expect(rateLimited.length, 'el portal debería haber respondido algún 429').toBeGreaterThan(0);
    expect(events).toHaveLength(rateLimited.length);
    rateLimited.forEach((limited, i) => {
      const event = events[i];
      expect(event?.accommodationId).toBe(accommodationOf(limited));
      expect(event?.from).toBe(limited.body?.from);
      expect(event?.to).toBe(limited.body?.to);
      const retryAfter = event?.retryAfter;
      expect(typeof retryAfter).toBe('number');
      const pauseEnd = Date.parse(limited.timestamp) + Number(retryAfter) * 1000;
      const early = puts.filter((put) => put.id > limited.id && Date.parse(put.timestamp) < pauseEnd);
      expect(early, `PUT dentro del Retry-After del 429 ${String(limited.id)}`).toEqual([]);
    });
  });
});
