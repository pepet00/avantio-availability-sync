import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDays,
  compareDays,
  daysInRange,
  enumerateDays,
  parseDay,
  todayUtc,
  type Day,
} from '../../src/dates.js';

function day(text: string): Day {
  const parsed = parseDay(text);
  if (parsed === null) {
    throw new Error(`Fecha de test inválida: ${text}`);
  }
  return parsed;
}

/** Comprueba que la lista empieza en `from`, acaba en `to` y cada día es el siguiente del anterior. */
function expectConsecutive(days: Day[], from: Day, to: Day): void {
  expect(days[0]).toBe(from);
  expect(days.at(-1)).toBe(to);
  expect(new Set(days).size).toBe(days.length);
  days.slice(1).forEach((current, i) => {
    const previous = days[i] ?? from;
    expect(current).toBe(addDays(previous, 1));
    expect(compareDays(previous, current)).toBeLessThan(0);
  });
}

describe('parseDay', () => {
  it('acepta fechas reales y devuelve el mismo texto', () => {
    expect(parseDay('2026-10-01')).toBe('2026-10-01');
    expect(parseDay('2026-12-31')).toBe('2026-12-31');
    expect(parseDay('2026-01-01')).toBe('2026-01-01');
  });

  it('acepta el 29 de febrero solo en años bisiestos (CA-7)', () => {
    expect(parseDay('2028-02-29')).toBe('2028-02-29');
    expect(parseDay('2000-02-29')).toBe('2000-02-29');
    expect(parseDay('2026-02-29')).toBeNull();
    expect(parseDay('2100-02-29')).toBeNull();
  });

  it('rechaza días que no existen (CA-7)', () => {
    expect(parseDay('2026-02-30')).toBeNull();
    expect(parseDay('2026-04-31')).toBeNull();
    expect(parseDay('2026-01-32')).toBeNull();
    expect(parseDay('2026-01-00')).toBeNull();
    expect(parseDay('2026-00-10')).toBeNull();
    expect(parseDay('2026-13-01')).toBeNull();
  });

  it('rechaza textos con otro formato', () => {
    for (const text of [
      '',
      '2026-1-01',
      '2026-01-1',
      '26-01-01',
      '2026/01/01',
      '01-01-2026',
      '20260101',
      ' 2026-01-01',
      '2026-01-01 ',
      '2026-01-01T00:00:00Z',
      '+02026-01-01',
      '２０２６-01-01',
      'abcd-ef-gh',
    ]) {
      expect(parseDay(text), text).toBeNull();
    }
  });

  it('rechaza sin lanzar los desbordes en los extremos del rango de años', () => {
    expect(parseDay('0000-01-00')).toBeNull();
    expect(parseDay('9999-12-32')).toBeNull();
    expect(parseDay('0000-01-01')).toBe('0000-01-01');
    expect(parseDay('9999-12-31')).toBe('9999-12-31');
  });

  it('no confunde los años 0-99 con 1900-1999', () => {
    expect(parseDay('0050-06-15')).toBe('0050-06-15');
  });
});

describe('todayUtc', () => {
  it('es el día UTC del instante: 23:59:59Z y 00:00:00Z caen en días distintos', () => {
    expect(todayUtc(new Date('2026-10-01T23:59:59.999Z'))).toBe('2026-10-01');
    expect(todayUtc(new Date('2026-10-02T00:00:00.000Z'))).toBe('2026-10-02');
  });

  it('usa UTC aunque el instante se exprese con otra zona', () => {
    expect(todayUtc(new Date('2026-10-02T01:30:00+02:00'))).toBe('2026-10-01');
    expect(todayUtc(new Date('2026-10-01T22:30:00-02:00'))).toBe('2026-10-02');
  });

  it('rechaza un instante inválido', () => {
    expect(() => todayUtc(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('addDays', () => {
  it('suma y resta cruzando fin de mes y de año', () => {
    expect(addDays(day('2026-10-31'), 1)).toBe('2026-11-01');
    expect(addDays(day('2026-12-31'), 1)).toBe('2027-01-01');
    expect(addDays(day('2027-01-01'), -1)).toBe('2026-12-31');
    expect(addDays(day('2028-02-28'), 1)).toBe('2028-02-29');
    expect(addDays(day('2026-02-28'), 1)).toBe('2026-03-01');
    expect(addDays(day('2026-10-01'), 0)).toBe('2026-10-01');
    expect(addDays(day('2026-10-01'), 365)).toBe('2027-10-01');
  });

  it('rechaza sumas no enteras y salirse del rango de años', () => {
    expect(() => addDays(day('2026-10-01'), 0.5)).toThrow(RangeError);
    expect(() => addDays(day('2026-10-01'), Number.NaN)).toThrow(RangeError);
    expect(() => addDays(day('9999-12-31'), 1)).toThrow(RangeError);
  });
});

describe('compareDays', () => {
  it('ordena por fecha', () => {
    expect(compareDays(day('2026-10-01'), day('2026-10-02'))).toBeLessThan(0);
    expect(compareDays(day('2026-10-02'), day('2026-10-01'))).toBeGreaterThan(0);
    expect(compareDays(day('2026-10-01'), day('2026-10-01'))).toBe(0);
    expect(compareDays(day('2026-12-31'), day('2027-01-01'))).toBeLessThan(0);
  });
});

describe('daysInRange', () => {
  it('cuenta los días de un rango inclusivo', () => {
    expect(daysInRange(day('2026-10-01'), day('2026-10-01'))).toBe(1);
    expect(daysInRange(day('2026-10-01'), day('2026-10-07'))).toBe(7);
    expect(daysInRange(day('2026-10-01'), day('2026-10-31'))).toBe(31);
    expect(daysInRange(day('2026-10-01'), day('2026-12-29'))).toBe(90);
    expect(daysInRange(day('2026-01-01'), day('2026-12-31'))).toBe(365);
    expect(daysInRange(day('2028-01-01'), day('2028-12-31'))).toBe(366);
    expect(daysInRange(day('2026-02-01'), day('2026-03-01'))).toBe(29);
    expect(daysInRange(day('2028-02-01'), day('2028-03-01'))).toBe(30);
  });

  it('rechaza un rango invertido', () => {
    expect(() => daysInRange(day('2026-10-02'), day('2026-10-01'))).toThrow(RangeError);
  });
});

describe('enumerateDays (CA-7: ni repite ni salta días)', () => {
  it('un solo día', () => {
    expect(enumerateDays(day('2026-10-01'), day('2026-10-01'))).toEqual(['2026-10-01']);
  });

  it('cruzando fin de mes', () => {
    const days = enumerateDays(day('2026-01-30'), day('2026-02-02'));

    expect(days).toEqual(['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
  });

  it('cruzando febrero de un año bisiesto y fin de año', () => {
    expect(enumerateDays(day('2028-02-27'), day('2028-03-01'))).toEqual([
      '2028-02-27',
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);
    expect(enumerateDays(day('2026-12-30'), day('2027-01-02'))).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
  });

  it('un rango largo tiene tantos días como daysInRange, consecutivos y sin repetir', () => {
    const from = day('2026-10-01');
    const to = day('2027-09-30');
    const days = enumerateDays(from, to);

    expect(days).toHaveLength(daysInRange(from, to));
    expectConsecutive(days, from, to);
  });

  it('rechaza un rango invertido', () => {
    expect(() => enumerateDays(day('2026-10-02'), day('2026-10-01'))).toThrow(RangeError);
  });

  describe('con la zona local en Europe/Madrid', () => {
    const originalTz = process.env.TZ;

    beforeAll(() => {
      process.env.TZ = 'Europe/Madrid';
    });

    afterAll(() => {
      if (originalTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTz;
      }
    });

    it('la zona local tiene el cambio de hora del 25 de octubre de 2026 (el test es significativo)', () => {
      const before = new Date('2026-10-24T12:00:00Z').getTimezoneOffset();
      const after = new Date('2026-10-26T12:00:00Z').getTimezoneOffset();

      expect(before).toBe(-120);
      expect(after).toBe(-60);
    });

    it('cruzando el cambio de hora del 25 de octubre de 2026', () => {
      const from = day('2026-10-23');
      const to = day('2026-10-28');
      const days = enumerateDays(from, to);

      expect(days).toEqual([
        '2026-10-23',
        '2026-10-24',
        '2026-10-25',
        '2026-10-26',
        '2026-10-27',
        '2026-10-28',
      ]);
      expect(daysInRange(from, to)).toBe(6);
      expect(addDays(day('2026-10-25'), 1)).toBe('2026-10-26');
      expect(addDays(day('2026-10-26'), -1)).toBe('2026-10-25');
      expect(todayUtc(new Date('2026-10-25T23:30:00Z'))).toBe('2026-10-25');
    });

    it('cruzando el cambio de hora de marzo de 2027', () => {
      expect(enumerateDays(day('2027-03-27'), day('2027-03-29'))).toEqual([
        '2027-03-27',
        '2027-03-28',
        '2027-03-29',
      ]);
    });
  });
});
