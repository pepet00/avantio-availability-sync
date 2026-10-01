import { afterEach, describe, expect, it, vi } from 'vitest';
import { advanceClock, now, resetClock } from '../../src/clock.js';

const DAY_MS = 86_400_000;

/** Lee `now()` entre dos lecturas de la hora real y devuelve su desplazamiento respecto a ellas. */
function readNow(): { value: number; realBefore: number; realAfter: number } {
  const realBefore = Date.now();
  const value = now().getTime();
  const realAfter = Date.now();
  return { value, realBefore, realAfter };
}

describe('clock', () => {
  afterEach(() => {
    resetClock();
  });

  it('sin desplazamiento sigue la hora real', () => {
    const { value, realBefore, realAfter } = readNow();

    expect(value).toBeGreaterThanOrEqual(realBefore);
    expect(value).toBeLessThanOrEqual(realAfter);
  });

  it('con desplazamiento salta hacia delante', () => {
    advanceClock(DAY_MS);
    const { value, realBefore, realAfter } = readNow();

    expect(value).toBeGreaterThanOrEqual(realBefore + DAY_MS);
    expect(value).toBeLessThanOrEqual(realAfter + DAY_MS);
  });

  it('los desplazamientos se acumulan', () => {
    advanceClock(DAY_MS);
    advanceClock(DAY_MS);
    const { value, realBefore, realAfter } = readNow();

    expect(value).toBeGreaterThanOrEqual(realBefore + 2 * DAY_MS);
    expect(value).toBeLessThanOrEqual(realAfter + 2 * DAY_MS);
  });

  it('desplazado, sigue avanzando con la hora real (no se congela)', async () => {
    advanceClock(DAY_MS);
    const first = now().getTime();

    await vi.waitFor(() => {
      expect(now().getTime()).toBeGreaterThan(first);
    });
  });

  it('resetClock vuelve a la hora real', () => {
    advanceClock(DAY_MS);
    resetClock();
    const { value, realBefore, realAfter } = readNow();

    expect(value).toBeGreaterThanOrEqual(realBefore);
    expect(value).toBeLessThanOrEqual(realAfter);
  });

  it('no se puede retrasar ni desplazar un valor no finito', () => {
    expect(() => {
      advanceClock(-1);
    }).toThrow(RangeError);
    expect(() => {
      advanceClock(Number.NaN);
    }).toThrow(RangeError);
    expect(() => {
      advanceClock(Number.POSITIVE_INFINITY);
    }).toThrow(RangeError);
  });
});
