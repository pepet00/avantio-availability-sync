// Reglas de `POST /updates`. Función pura: recibe el cuerpo ya parseado y el "hoy" del reloj.

import { compareDays, daysInRange, parseDay, type Day } from '../dates.js';
import type { AccommodationUpdate } from '../sync/state.js';

export type RejectionCode = 'INVALID_BODY' | 'INVALID_DATE' | 'DATE_IN_PAST' | 'RANGE_TOO_LARGE';

export type ValidationResult =
  | { ok: true; update: AccommodationUpdate; days: number }
  | { ok: false; code: RejectionCode; message: string };

const FIELDS = ['accommodationId', 'from', 'to', 'available', 'pricePerNight'] as const;
const MAX_ID_LENGTH = 64;
const MAX_RANGE_DAYS = 365;

/** Valida un update. Las reglas se comprueban en el orden de la tabla de la SPEC. */
export function validateUpdate(body: unknown, today: Day): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return reject('INVALID_BODY', 'El cuerpo debe ser un objeto JSON');
  }
  const fields = body as Record<string, unknown>;

  const extra = Object.keys(fields).filter((key) => !(FIELDS as readonly string[]).includes(key));
  if (extra.length > 0) {
    return reject('INVALID_BODY', `Campos no permitidos: ${extra.join(', ')}`);
  }
  const missing = FIELDS.filter((key) => !(key in fields));
  if (missing.length > 0) {
    return reject('INVALID_BODY', `Faltan campos: ${missing.join(', ')}`);
  }

  const { accommodationId, from, to, available, pricePerNight } = fields;
  if (typeof accommodationId !== 'string') {
    return reject('INVALID_BODY', 'accommodationId debe ser una cadena');
  }
  if (typeof from !== 'string' || typeof to !== 'string') {
    return reject('INVALID_BODY', 'from y to deben ser cadenas YYYY-MM-DD');
  }
  if (typeof available !== 'boolean') {
    return reject('INVALID_BODY', 'available debe ser un booleano');
  }
  // Un número JSON enorme (1e400) se parsea como Infinity.
  if (typeof pricePerNight !== 'number' || !Number.isFinite(pricePerNight)) {
    return reject('INVALID_BODY', 'pricePerNight debe ser un número');
  }

  if (accommodationId === '' || accommodationId.trim() !== accommodationId) {
    return reject('INVALID_BODY', 'accommodationId no puede estar vacío ni tener espacios en los extremos');
  }
  if (accommodationId.length > MAX_ID_LENGTH) {
    return reject('INVALID_BODY', `accommodationId no puede tener más de ${String(MAX_ID_LENGTH)} caracteres`);
  }
  if (pricePerNight < 0) {
    return reject('INVALID_BODY', 'pricePerNight debe ser mayor o igual que 0');
  }

  const fromDay = parseDay(from);
  const toDay = parseDay(to);
  if (fromDay === null || toDay === null) {
    return reject('INVALID_DATE', 'from y to deben ser fechas reales con formato YYYY-MM-DD');
  }
  if (compareDays(toDay, fromDay) < 0) {
    return reject('INVALID_DATE', 'to no puede ser anterior a from');
  }
  if (compareDays(fromDay, today) < 0) {
    return reject('DATE_IN_PAST', `from no puede ser anterior a hoy (${today})`);
  }
  const days = daysInRange(fromDay, toDay);
  if (days > MAX_RANGE_DAYS) {
    return reject('RANGE_TOO_LARGE', `El rango no puede tener más de ${String(MAX_RANGE_DAYS)} días`);
  }

  return { ok: true, update: { accommodationId, from: fromDay, to: toDay, available, pricePerNight }, days };
}

function reject(code: RejectionCode, message: string): ValidationResult {
  return { ok: false, code, message };
}
