import { describe, expect, it } from 'vitest';
import { addDays, parseDay, type Day } from '../../src/dates.js';
import { validateUpdate } from '../../src/updates/validation.js';

function day(text: string): Day {
  const parsed = parseDay(text);
  if (parsed === null) throw new Error(`Fecha de test inválida: ${text}`);
  return parsed;
}

const TODAY = day('2026-10-01');

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accommodationId: 'acc-1003',
    from: '2026-10-01',
    to: '2026-10-07',
    available: true,
    pricePerNight: 120,
    ...overrides,
  };
}

/** Cuerpo sin el campo indicado. */
function without(field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body()).filter(([key]) => key !== field));
}

/** Rango de `days` días desde hoy. */
function rangeOf(days: number): Record<string, unknown> {
  return body({ from: TODAY, to: addDays(TODAY, days - 1) });
}

function codeOf(input: unknown): string {
  const result = validateUpdate(input, TODAY);
  return result.ok ? 'OK' : result.code;
}

describe('validación de POST /updates', () => {
  it('un update válido devuelve el update con fechas validadas y su número de días', () => {
    expect(validateUpdate(body(), TODAY)).toEqual({
      ok: true,
      update: { accommodationId: 'acc-1003', from: '2026-10-01', to: '2026-10-07', available: true, pricePerNight: 120 },
      days: 7,
    });
  });

  it.each([
    ['un campo de más', body({ extra: 1 })],
    ['falta pricePerNight', without('pricePerNight')],
    ['available no es booleano', body({ available: 'true' })],
    ['pricePerNight no es un número', body({ pricePerNight: '120' })],
    ['accommodationId vacío', body({ accommodationId: '' })],
    ['accommodationId con espacio al principio', body({ accommodationId: ' acc-1003' })],
    ['accommodationId con espacio al final', body({ accommodationId: 'acc-1003 ' })],
    ['accommodationId de 65 caracteres', body({ accommodationId: 'a'.repeat(65) })],
    ['pricePerNight negativo', body({ pricePerNight: -0.01 })],
  ])('INVALID_BODY si %s', (_case, input) => {
    expect(codeOf(input)).toBe('INVALID_BODY');
  });

  it('acepta un accommodationId de 64 caracteres y un precio 0', () => {
    expect(codeOf(body({ accommodationId: 'a'.repeat(64), pricePerNight: 0 }))).toBe('OK');
  });

  it.each([
    ['from es 2026-02-30', body({ from: '2026-02-30' })],
    ['to es anterior a from', body({ from: '2026-10-07', to: '2026-10-06' })],
  ])('INVALID_DATE si %s', (_case, input) => {
    expect(codeOf(input)).toBe('INVALID_DATE');
  });

  it('DATE_IN_PAST si from es ayer; from = hoy se acepta', () => {
    expect(codeOf(body({ from: addDays(TODAY, -1) }))).toBe('DATE_IN_PAST');
    expect(codeOf(body({ from: TODAY }))).toBe('OK');
  });

  it('acepta 32 y 365 días; RANGE_TOO_LARGE con 366', () => {
    expect(codeOf(rangeOf(32))).toBe('OK');
    expect(codeOf(rangeOf(365))).toBe('OK');
    expect(codeOf(rangeOf(366))).toBe('RANGE_TOO_LARGE');
  });
});
