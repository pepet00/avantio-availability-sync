import { describe, expect, it } from 'vitest';
import { addDays, compareDays, daysInRange, enumerateDays, parseDay, type Day } from '../../src/dates.js';
import { groupPendingRanges, MAX_RANGE_DAYS, type DesiredDay } from '../../src/sync/grouping.js';

function day(text: string): Day {
  const parsed = parseDay(text);
  if (parsed === null) {
    throw new Error(`Fecha de test inválida: ${text}`);
  }
  return parsed;
}

const TODAY = day('2026-10-01');

/** Día pendiente: versión 2 frente a 1 sincronizada. */
function pendingDay(available = true, price = 100): DesiredDay {
  return { available, price, version: 2, syncedVersion: 1 };
}

/** `count` días pendientes e iguales desde `from`. */
function sameDays(from: Day, count: number, state: DesiredDay = pendingDay()): Record<string, DesiredDay> {
  const days: Record<string, DesiredDay> = {};
  for (const d of enumerateDays(from, addDays(from, count - 1))) {
    days[d] = { ...state };
  }
  return days;
}

/** PRNG con semilla (mulberry32) para que las entradas aleatorias sean reproducibles. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('groupPendingRanges', () => {
  it('sin días pendientes no hay grupos', () => {
    expect(groupPendingRanges({}, TODAY)).toEqual([]);
  });

  it('días consecutivos con los mismos valores forman un solo grupo', () => {
    expect(groupPendingRanges(sameDays(TODAY, 7), TODAY)).toEqual([
      { from: '2026-10-01', to: '2026-10-07', available: true, pricePerNight: 100 },
    ]);
  });

  it('un hueco abre grupo', () => {
    const days = { ...sameDays(day('2026-10-01'), 3), ...sameDays(day('2026-10-05'), 2) };
    expect(groupPendingRanges(days, TODAY)).toEqual([
      { from: '2026-10-01', to: '2026-10-03', available: true, pricePerNight: 100 },
      { from: '2026-10-05', to: '2026-10-06', available: true, pricePerNight: 100 },
    ]);
  });

  it('un cambio de available abre grupo', () => {
    const days = {
      ...sameDays(day('2026-10-01'), 2, pendingDay(true, 100)),
      ...sameDays(day('2026-10-03'), 2, pendingDay(false, 100)),
    };
    expect(groupPendingRanges(days, TODAY)).toEqual([
      { from: '2026-10-01', to: '2026-10-02', available: true, pricePerNight: 100 },
      { from: '2026-10-03', to: '2026-10-04', available: false, pricePerNight: 100 },
    ]);
  });

  it('un cambio de precio abre grupo', () => {
    const days = {
      ...sameDays(day('2026-10-01'), 2, pendingDay(true, 100)),
      ...sameDays(day('2026-10-03'), 1, pendingDay(true, 100.5)),
      ...sameDays(day('2026-10-04'), 1, pendingDay(true, 100)),
    };
    expect(groupPendingRanges(days, TODAY)).toEqual([
      { from: '2026-10-01', to: '2026-10-02', available: true, pricePerNight: 100 },
      { from: '2026-10-03', to: '2026-10-03', available: true, pricePerNight: 100.5 },
      { from: '2026-10-04', to: '2026-10-04', available: true, pricePerNight: 100 },
    ]);
  });

  it('31 días iguales dan 1 grupo', () => {
    expect(groupPendingRanges(sameDays(TODAY, 31), TODAY)).toEqual([
      { from: '2026-10-01', to: '2026-10-31', available: true, pricePerNight: 100 },
    ]);
  });

  it('32 días iguales dan 2 grupos', () => {
    expect(groupPendingRanges(sameDays(TODAY, 32), TODAY)).toEqual([
      { from: '2026-10-01', to: '2026-10-31', available: true, pricePerNight: 100 },
      { from: '2026-11-01', to: '2026-11-01', available: true, pricePerNight: 100 },
    ]);
  });

  it('90 días iguales desde el 1 de octubre dan exactamente 3 grupos: 1–31 oct, 1 nov–1 dic, 2–29 dic (CA-3)', () => {
    const groups = groupPendingRanges(sameDays(TODAY, 90), TODAY);
    expect(groups).toEqual([
      { from: '2026-10-01', to: '2026-10-31', available: true, pricePerNight: 100 },
      { from: '2026-11-01', to: '2026-12-01', available: true, pricePerNight: 100 },
      { from: '2026-12-02', to: '2026-12-29', available: true, pricePerNight: 100 },
    ]);
    for (const group of groups) {
      expect(daysInRange(group.from, group.to)).toBeLessThanOrEqual(MAX_RANGE_DAYS);
    }
  });

  it('ignora los días ya sincronizados', () => {
    const days = sameDays(TODAY, 5);
    days['2026-10-03'] = { available: true, price: 100, version: 2, syncedVersion: 2 };
    expect(groupPendingRanges(days, TODAY)).toEqual([
      { from: '2026-10-01', to: '2026-10-02', available: true, pricePerNight: 100 },
      { from: '2026-10-04', to: '2026-10-05', available: true, pricePerNight: 100 },
    ]);
  });

  it('ignora los días anteriores a hoy aunque estén pendientes; hoy sí entra', () => {
    const days = sameDays(day('2026-09-28'), 6);
    expect(groupPendingRanges(days, TODAY)).toEqual([
      { from: '2026-10-01', to: '2026-10-03', available: true, pricePerNight: 100 },
    ]);
    expect(groupPendingRanges(sameDays(day('2026-09-28'), 3), TODAY)).toEqual([]);
  });

  it('el orden de las claves del documento no importa', () => {
    const days: Record<string, DesiredDay> = {};
    for (const d of enumerateDays(day('2026-10-01'), day('2026-10-05')).reverse()) {
      days[d] = pendingDay();
    }
    expect(groupPendingRanges(days, TODAY)).toEqual([
      { from: '2026-10-01', to: '2026-10-05', available: true, pricePerNight: 100 },
    ]);
  });

  it('cruza fin de mes y el cambio de hora del 25 de octubre sin repetir ni saltar días (CA-7)', () => {
    const groups = groupPendingRanges(sameDays(day('2026-10-20'), 15), TODAY);
    expect(groups).toEqual([
      { from: '2026-10-20', to: '2026-11-03', available: true, pricePerNight: 100 },
    ]);
  });

  it('rechaza una clave que no es una fecha real', () => {
    expect(() => groupPendingRanges({ '2026-02-30': pendingDay() }, TODAY)).toThrow(RangeError);
  });

  it('para cualquier entrada, los grupos cubren cada día pendiente exactamente una vez y ninguno supera 31 días (CA-7)', () => {
    const random = seededRandom(20261001);
    const pick = <T>(options: readonly T[]): T => options[Math.floor(random() * options.length)] as T;

    for (let run = 0; run < 200; run++) {
      // Días desde 30 antes de hoy hasta ~400 después, con huecos, días sincronizados y pocos valores
      // distintos para que haya tramos largos iguales.
      const days: Record<string, DesiredDay> = {};
      const start = addDays(TODAY, -30);
      const span = 1 + Math.floor(random() * 430);
      for (const d of enumerateDays(start, addDays(start, span - 1))) {
        if (random() < 0.1) {
          continue;
        }
        const synced = random() < 0.1;
        days[d] = {
          available: random() < 0.97,
          price: pick([100, 100, 100, 120.5]),
          version: 3,
          syncedVersion: synced ? 3 : pick([0, 1, 2]),
        };
      }

      const expected = Object.entries(days)
        .filter(([d, s]) => s.version > s.syncedVersion && compareDays(day(d), TODAY) >= 0)
        .map(([d]) => day(d))
        .sort(compareDays);

      const groups = groupPendingRanges(days, TODAY);
      const covered: Day[] = [];
      let previousTo: Day | undefined;
      for (const group of groups) {
        expect(compareDays(group.from, group.to)).toBeLessThanOrEqual(0);
        expect(daysInRange(group.from, group.to)).toBeLessThanOrEqual(MAX_RANGE_DAYS);
        if (previousTo !== undefined) {
          expect(compareDays(previousTo, group.from)).toBeLessThan(0);
        }
        for (const d of enumerateDays(group.from, group.to)) {
          // Cada día del grupo es pendiente y lleva los valores del grupo.
          const state = days[d];
          expect(state).toBeDefined();
          expect(state?.available).toBe(group.available);
          expect(state?.price).toBe(group.pricePerNight);
          covered.push(d);
        }
        previousTo = group.to;
      }
      expect(covered).toEqual(expected);
    }
  });
});
