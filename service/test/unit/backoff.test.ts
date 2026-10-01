import { describe, expect, it } from 'vitest';
import { backoffCeilingMs, backoffDelayMs, type BackoffConfig } from '../../src/sync/backoff.js';

const CONFIG: BackoffConfig = { backoffBaseMs: 2_000, backoffMaxMs: 300_000 };

describe('backoffCeilingMs', () => {
  it('es base × 2^(attempts−1) mientras no llega al tope', () => {
    expect(backoffCeilingMs(1, CONFIG)).toBe(2_000);
    expect(backoffCeilingMs(2, CONFIG)).toBe(4_000);
    expect(backoffCeilingMs(3, CONFIG)).toBe(8_000);
    expect(backoffCeilingMs(8, CONFIG)).toBe(256_000);
  });

  it('crece con attempts y nunca supera el tope', () => {
    let previous = 0;
    for (let attempts = 1; attempts <= 2_000; attempts++) {
      const ceiling = backoffCeilingMs(attempts, CONFIG);
      expect(ceiling).toBeGreaterThanOrEqual(previous);
      expect(ceiling).toBeLessThanOrEqual(CONFIG.backoffMaxMs);
      previous = ceiling;
    }
    expect(backoffCeilingMs(9, CONFIG)).toBe(300_000);
    expect(backoffCeilingMs(2_000, CONFIG)).toBe(300_000);
  });

  it('rechaza attempts que no son un entero >= 1', () => {
    for (const attempts of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => backoffCeilingMs(attempts, CONFIG), String(attempts)).toThrow(RangeError);
    }
  });
});

describe('backoffDelayMs (full jitter)', () => {
  it('usa la fuente de azar inyectada para escalar el tope', () => {
    expect(backoffDelayMs(3, CONFIG, () => 0)).toBe(0);
    expect(backoffDelayMs(3, CONFIG, () => 0.5)).toBe(4_000);
    expect(backoffDelayMs(3, CONFIG, () => 0.999_999)).toBe(7_999);
  });

  it('queda siempre entre 0 y el tope de su intento', () => {
    let seed = 1;
    const random = (): number => {
      seed = (seed * 16_807) % 2_147_483_647;
      return (seed - 1) / 2_147_483_646;
    };
    for (let attempts = 1; attempts <= 20; attempts++) {
      const ceiling = backoffCeilingMs(attempts, CONFIG);
      for (let i = 0; i < 100; i++) {
        const delay = backoffDelayMs(attempts, CONFIG, random);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(ceiling);
        expect(Number.isInteger(delay)).toBe(true);
      }
    }
  });

  it('por defecto usa Math.random y respeta el tope', () => {
    for (let i = 0; i < 100; i++) {
      const delay = backoffDelayMs(20, CONFIG);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(CONFIG.backoffMaxMs);
    }
  });

  it('rechaza una fuente de azar fuera de [0, 1)', () => {
    for (const value of [-0.1, 1, 2, Number.NaN]) {
      expect(() => backoffDelayMs(1, CONFIG, () => value), String(value)).toThrow(RangeError);
    }
  });
});
