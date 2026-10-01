// Días de calendario `YYYY-MM-DD` en UTC. Módulo puro: toda validación y aritmética de días pasa por aquí.
// La aritmética se hace sobre días desde epoch (Date.UTC), nunca sobre el texto ni con getDate/setDate locales.

const MS_PER_DAY = 86_400_000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_YEAR = 0;
const MAX_YEAR = 9999;

/** Día de calendario validado. Solo se obtiene con `parseDay`, `todayUtc` o la aritmética de este módulo. */
export type Day = string & { readonly __brand: 'Day' };

/** Valida un texto `YYYY-MM-DD` con ida y vuelta: se parsea, se reformatea y debe coincidir (nunca un 30 de febrero). */
export function parseDay(text: string): Day | null {
  const match = DAY_PATTERN.exec(text);
  if (match === null) {
    return null;
  }
  const [, year, month, day] = match;
  const epochDay = epochDayOf(Number(year), Number(month), Number(day));
  return formatOrNull(epochDay) === text ? (text as Day) : null;
}

/** "Hoy": el día UTC del instante recibido. */
export function todayUtc(instant: Date): Day {
  const ms = instant.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError('Instante inválido');
  }
  return format(Math.floor(ms / MS_PER_DAY));
}

/** Suma (o resta, con `n` negativo) días enteros. */
export function addDays(day: Day, n: number): Day {
  if (!Number.isInteger(n)) {
    throw new RangeError(`Solo se suman días enteros: ${String(n)}`);
  }
  return format(toEpochDay(day) + n);
}

/** Negativo si `a` es anterior a `b`, 0 si son el mismo día, positivo si es posterior. */
export function compareDays(a: Day, b: Day): number {
  return toEpochDay(a) - toEpochDay(b);
}

/** Número de días del rango inclusivo `[from, to]` (mismo día = 1). Exige `to >= from`. */
export function daysInRange(from: Day, to: Day): number {
  const count = compareDays(to, from) + 1;
  if (count < 1) {
    throw new RangeError(`Rango invertido: ${from} > ${to}`);
  }
  return count;
}

/** Todos los días del rango inclusivo `[from, to]`, en orden. Exige `to >= from`. */
export function enumerateDays(from: Day, to: Day): Day[] {
  const count = daysInRange(from, to);
  const start = toEpochDay(from);
  return Array.from({ length: count }, (_, i) => format(start + i));
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HTTP_DATE_PATTERN = new RegExp(
  `^(${WEEKDAYS.join('|')}), (\\d{2}) (${MONTHS.join('|')}) (\\d{4}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$`,
);

/**
 * Instante de una fecha HTTP en formato IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`), el que
 * deben generar los servidores. Validada con ida y vuelta, incluido el día de la semana.
 * Los formatos obsoletos (RFC 850 y asctime) y cualquier otro texto devuelven `null`.
 */
export function parseHttpDate(text: string): Date | null {
  const match = HTTP_DATE_PATTERN.exec(text);
  if (match === null) {
    return null;
  }
  const [, weekday, dayOfMonth, monthName, year, hours, minutes, seconds] = match;
  const month = String(MONTHS.indexOf(monthName ?? '') + 1).padStart(2, '0');
  const day = parseDay(`${year ?? ''}-${month}-${dayOfMonth ?? ''}`);
  const [h, m, s] = [Number(hours), Number(minutes), Number(seconds)];
  if (day === null || h > 23 || m > 59 || s > 59) {
    return null;
  }
  const epochDay = toEpochDay(day);
  // El 1 de enero de 1970 (día 0) fue jueves.
  if (WEEKDAYS[(((epochDay + 4) % 7) + 7) % 7] !== weekday) {
    return null;
  }
  return new Date(epochDay * MS_PER_DAY + ((h * 60 + m) * 60 + s) * 1000);
}

function toEpochDay(day: Day): number {
  const match = DAY_PATTERN.exec(day);
  if (match === null) {
    throw new RangeError(`Día inválido: ${day}`);
  }
  const [, year, month, dayOfMonth] = match;
  return epochDayOf(Number(year), Number(month), Number(dayOfMonth));
}

function epochDayOf(year: number, month: number, day: number): number {
  // setUTCFullYear y no Date.UTC: Date.UTC trata los años 0-99 como 1900-1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return Math.floor(date.getTime() / MS_PER_DAY);
}

function format(epochDay: number): Day {
  const day = formatOrNull(epochDay);
  if (day === null) {
    throw new RangeError(`Día fuera del rango de años ${String(MIN_YEAR)}-${String(MAX_YEAR)}`);
  }
  return day;
}

function formatOrNull(epochDay: number): Day | null {
  const date = new Date(epochDay * MS_PER_DAY);
  const year = date.getUTCFullYear();
  if (!Number.isFinite(year) || year < MIN_YEAR || year > MAX_YEAR) {
    return null;
  }
  const yyyy = String(year).padStart(4, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}` as Day;
}
