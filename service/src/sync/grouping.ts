// Agrupación de los días pendientes en los rangos que se envían al portal (un PUT por grupo).
// Función pura: la usan el worker para enviar y sync-status para mostrar `pendingRanges`.

import { addDays, compareDays, daysInRange, parseDay, type Day } from '../dates.js';

/** Máximo de días por PUT que admite el portal (invariante 6). */
export const MAX_RANGE_DAYS = 31;

/** Estado deseado de un día, tal como se guarda en `days` del documento. */
export interface DesiredDay {
  available: boolean;
  price: number;
  version: number;
  syncedVersion: number;
}

/** Un rango inclusivo con los mismos valores: el cuerpo de un PUT. */
export interface PendingRange {
  from: Day;
  to: Day;
  available: boolean;
  pricePerNight: number;
}

/**
 * Agrupa los días pendientes (`version > syncedVersion`) de `today` en adelante, en orden.
 * Abre un grupo nuevo si hay un hueco, si cambian los valores o si el grupo ya tiene 31 días.
 */
export function groupPendingRanges(days: Readonly<Record<string, DesiredDay>>, today: Day): PendingRange[] {
  const pending: { day: Day; state: DesiredDay }[] = [];
  for (const [key, state] of Object.entries(days)) {
    const day = parseDay(key);
    if (day === null) {
      throw new RangeError(`Día inválido en el documento: ${key}`);
    }
    if (state.version > state.syncedVersion && compareDays(day, today) >= 0) {
      pending.push({ day, state });
    }
  }
  pending.sort((a, b) => compareDays(a.day, b.day));

  const groups: PendingRange[] = [];
  let current: PendingRange | undefined;
  for (const { day, state } of pending) {
    const extendsCurrent =
      current !== undefined &&
      addDays(current.to, 1) === day &&
      current.available === state.available &&
      current.pricePerNight === state.price &&
      daysInRange(current.from, current.to) < MAX_RANGE_DAYS;
    if (current !== undefined && extendsCurrent) {
      current.to = day;
    } else {
      current = { from: day, to: day, available: state.available, pricePerNight: state.price };
      groups.push(current);
    }
  }
  return groups;
}
