// Transiciones del estado de un alojamiento. Funciones puras: el repositorio las aplica con la
// condición de `rev` y, si otra escritura se adelanta, las vuelve a calcular sobre el estado nuevo.

import { addMs } from '../clock.js';
import type { Config } from '../config.js';
import { enumerateDays, todayUtc, type Day } from '../dates.js';
import type { FailureOutcome, PortalError } from '../portal/client.js';
import type { AccommodationDoc, LastError, SyncStatus } from '../storage/types.js';
import { backoffDelayMs, type BackoffConfig } from './backoff.js';
import { groupPendingRanges, type DesiredDay, type PendingRange } from './grouping.js';

/** Update ya validado (las fechas son días reales, `from` es de hoy o posterior). */
export interface AccommodationUpdate {
  accommodationId: string;
  from: Day;
  to: Day;
  available: boolean;
  pricePerNight: number;
}

/**
 * Campos que escribe un update. Los opcionales solo se escriben cuando corresponde; el resto
 * del documento (incluido `leaseUntil`) es del worker.
 */
export interface UpdatePatch {
  seq: number;
  /** Solo los días cuyos valores cambian. */
  days: Record<Day, DesiredDay>;
  pending: boolean;
  pendingSince: Date | null;
  attempts?: number;
  nextAttemptAt?: Date | null;
  status?: SyncStatus;
}

export type UpdateConfig = Pick<Config, 'timeoutGraceMs'>;

/** Fallos tras los que no se envía nada del alojamiento antes del margen (invariante 5). */
const GRACE_ERROR_CODES = new Set(['TIMEOUT', 'CONNECTION_ERROR']);

/** Aplica un update al documento (`null` si es el primero del alojamiento) en el instante `at`. */
export function applyUpdate(
  current: AccommodationDoc | null,
  update: AccommodationUpdate,
  at: Date,
  config: UpdateConfig,
): UpdatePatch {
  const seq = (current?.seq ?? 0) + 1;

  // Un día con los mismos valores no cambia de versión ni se reenvía.
  const days: Record<Day, DesiredDay> = {};
  for (const day of enumerateDays(update.from, update.to)) {
    const stored = current?.days[day];
    if (stored?.available === update.available && stored.price === update.pricePerNight) continue;
    days[day] = {
      available: update.available,
      price: update.pricePerNight,
      version: seq,
      syncedVersion: stored?.syncedVersion ?? 0,
    };
  }
  const changed = Object.keys(days).length > 0;

  const status = current?.status ?? 'synced';
  const wasPending = current?.pending ?? false;
  const pending = wasPending || changed || status === 'error';
  const patch: UpdatePatch = {
    seq,
    days,
    pending,
    pendingSince: pending ? (current?.pendingSince ?? at) : null,
  };

  // En `error`, un update es la única forma de pedir un nuevo intento: vale aunque no cambie nada.
  if (status === 'error' || (changed && !wasPending)) {
    return { ...patch, status: 'pending', attempts: 0, nextAttemptAt: at };
  }
  // Sin cambios no hay nada nuevo que enviar; en `failing` no se gasta cuota con el portal caído.
  if (!changed || status === 'failing' || current === null) {
    return patch;
  }

  const { lastError } = current;
  const scheduled = current.nextAttemptAt ?? at;
  if (lastError !== null && GRACE_ERROR_CODES.has(lastError.code)) {
    const graceEnd = addMs(lastError.at, config.timeoutGraceMs);
    return { ...patch, nextAttemptAt: latest(at, graceEnd) };
  }
  // Esperando por `5xx`/`401` (o ya programado): se adelanta a ahora, nunca se retrasa.
  return { ...patch, nextAttemptAt: earliest(at, scheduled) };
}

/**
 * Campos que escribe el worker. Los ausentes no cambian; `syncedVersions` lleva solo los días que
 * pasan a sincronizados, con la versión confirmada.
 */
export interface SyncPatch {
  syncedVersions?: Record<string, number>;
  pending?: boolean;
  pendingSince?: Date | null;
  nextAttemptAt?: Date | null;
  attempts?: number;
  status?: SyncStatus;
  lastError?: LastError | null;
  lastSyncedAt?: Date;
}

/** Versión de cada día del rango tal como se envía: la que confirmará un `200`. */
export function sentVersions(days: Readonly<Record<string, DesiredDay>>, range: PendingRange): Record<string, number> {
  const versions: Record<string, number> = {};
  for (const day of enumerateDays(range.from, range.to)) {
    const state = days[day];
    if (state === undefined) throw new RangeError(`El rango ${range.from} → ${range.to} incluye un día sin estado: ${day}`);
    versions[day] = state.version;
  }
  return versions;
}

/**
 * Tras un `200` en el instante `at`: se marcan sincronizados los días enviados cuya versión no
 * cambió mientras el PUT estaba en camino (invariante 2). Los demás siguen pendientes y se
 * reenviarán con su valor nuevo.
 */
export function confirmRange(current: AccommodationDoc, sent: Readonly<Record<string, number>>, at: Date): SyncPatch {
  const days = { ...current.days };
  const syncedVersions: Record<string, number> = {};
  for (const [day, version] of Object.entries(sent)) {
    const state = current.days[day];
    if (state?.version !== version) continue;
    syncedVersions[day] = version;
    days[day] = { ...state, syncedVersion: version };
  }

  const remaining = groupPendingRanges(days, todayUtc(at)).length > 0;
  return {
    syncedVersions,
    attempts: 0,
    lastError: null,
    lastSyncedAt: at,
    // Si quedan pendientes, el siguiente intento es inmediato.
    ...(remaining
      ? { pending: true, pendingSince: current.pendingSince ?? at, nextAttemptAt: at, status: 'pending' }
      : SYNCED),
  };
}

/** Rechazo permanente del portal (`404` o `400` y demás `4xx`): no se reintenta sin un update nuevo. */
export type PermanentOutcome = 'not_found' | 'bad_request';

export type RetryableOutcome = Exclude<FailureOutcome, PermanentOutcome>;

export function isPermanentOutcome(outcome: FailureOutcome): outcome is PermanentOutcome {
  return outcome === 'not_found' || outcome === 'bad_request';
}

/** Fallo reintentable del portal tal como lo devuelve el cliente. */
export interface RetryableFailure {
  outcome: RetryableOutcome;
  error: PortalError;
}

export type RetryConfig = BackoffConfig & Pick<Config, 'timeoutGraceMs' | 'failingThreshold'>;

/** Cambio que escribe un fallo reintentable: siempre fija estos campos. */
export interface FailurePatch extends SyncPatch {
  attempts: number;
  nextAttemptAt: Date;
  status: 'pending' | 'failing';
  lastError: LastError;
}

/** Sin respuesta: la petición puede aplicarse aún en el portal (invariante 5). */
const GRACE_OUTCOMES = new Set<RetryableOutcome>(['timeout', 'connection_error']);

/**
 * Fallo reintentable del PUT en el instante `at`: un fallo seguido más y el siguiente intento tras
 * el backoff (un instante, no un timer). Tras un timeout o error de conexión, nunca antes del margen.
 * Con `failingThreshold` fallos seguidos o más, `failing`.
 */
export function recordFailure(
  current: AccommodationDoc,
  { outcome, error }: RetryableFailure,
  at: Date,
  config: RetryConfig,
  random: () => number = Math.random,
): FailurePatch {
  const attempts = current.attempts + 1;
  const backoff = backoffDelayMs(attempts, config, random);
  const delay = GRACE_OUTCOMES.has(outcome) ? Math.max(config.timeoutGraceMs, backoff) : backoff;
  return {
    attempts,
    nextAttemptAt: addMs(at, delay),
    status: attempts >= config.failingThreshold ? 'failing' : 'pending',
    lastError: { code: error.code, message: error.message, at },
  };
}

/** Cambio que escribe un rechazo permanente: `error` o, si llegó un update, un intento inmediato. */
export type PermanentErrorPatch =
  | { status: 'error'; nextAttemptAt: null; lastError: LastError }
  | { nextAttemptAt: Date; lastError: LastError };

/**
 * `404` o `400` del portal en el instante `at` para un PUT preparado con el documento en `sentSeq`.
 * Sin updates de por medio, `error`: el worker no lo vuelve a coger hasta que llegue uno. Si llegó
 * alguno (subió `seq`), el estado nuevo puede ser válido: se reintenta de inmediato, sin tocar
 * `attempts` ni `status`, y solo pasa a `error` si vuelve a fallar sin cambios.
 */
export function recordPermanentError(
  current: AccommodationDoc,
  sentSeq: number,
  error: PortalError,
  at: Date,
): PermanentErrorPatch {
  const lastError = { code: error.code, message: error.message, at };
  if (current.seq !== sentSeq) return { nextAttemptAt: at, lastError };
  return { status: 'error', nextAttemptAt: null, lastError };
}

/**
 * Alojamiento marcado como pendiente sin nada que enviar de hoy en adelante (sus días pendientes
 * ya han pasado): queda sincronizado. `null` si no hay nada que cambiar.
 */
export function settleWithoutPending(current: AccommodationDoc, at: Date): SyncPatch | null {
  if (!current.pending || groupPendingRanges(current.days, todayUtc(at)).length > 0) return null;
  return { ...SYNCED, attempts: 0, lastError: null };
}

const SYNCED = { pending: false, pendingSince: null, nextAttemptAt: null, status: 'synced' } as const satisfies SyncPatch;

function latest(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

function earliest(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}
