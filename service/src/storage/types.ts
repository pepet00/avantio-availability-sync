// Documento de `accommodations_sync`: el estado deseado por día de un alojamiento y su sincronización.
// Es la fuente de verdad de la que leen el worker, sync-status y las métricas.

import type { DesiredDay } from '../sync/grouping.js';

export type SyncStatus = 'synced' | 'pending' | 'failing' | 'error';

export const SYNC_STATUSES: readonly SyncStatus[] = ['synced', 'pending', 'failing', 'error'];

/**
 * Último fallo del portal; se borra con el siguiente `200`. `code` es el del portal o, si no hubo
 * respuesta, el del cliente (`TIMEOUT`, `CONNECTION_ERROR`).
 */
export interface LastError {
  code: string;
  message: string;
  at: Date;
}

export interface AccommodationDoc {
  /** `accommodationId`. */
  _id: string;
  /** Sube con cada update aceptado y nunca se reinicia. */
  seq: number;
  /** Sube con cada escritura de estado: condición de la concurrencia optimista. */
  rev: number;
  /** Días sueltos `YYYY-MM-DD`; los rangos solo se calculan al enviar. */
  days: Record<string, DesiredDay>;
  /** Hay algún día pendiente de hoy o posterior. */
  pending: boolean;
  pendingSince: Date | null;
  nextAttemptAt: Date | null;
  /** Fallos seguidos; 0 con cada PUT correcto. */
  attempts: number;
  leaseUntil: Date | null;
  status: SyncStatus;
  lastError: LastError | null;
  lastSyncedAt: Date | null;
}
