// `GET /accommodations/:id/sync-status`: si los cambios de un alojamiento han llegado al portal y,
// si no, por qué. Se lee del documento; solo `pendingRanges` y `pendingDays` se calculan, con "hoy".

import type { FastifyInstance } from 'fastify';
import { now } from '../clock.js';
import { daysInRange, todayUtc } from '../dates.js';
import { errorBody } from '../errors.js';
import type { AccommodationRepository } from '../storage/repository.js';
import type { AccommodationDoc, SyncStatus } from '../storage/types.js';
import { groupPendingRanges, type PendingRange } from '../sync/grouping.js';

export interface SyncStatusResponse {
  accommodationId: string;
  status: SyncStatus;
  pendingDays: number;
  pendingSince: string | null;
  pendingRanges: PendingRange[];
  attempts: number;
  nextAttemptAt: string | null;
  lastError: { code: string; message: string; at: string } | null;
  lastSyncedAt: string | null;
}

export interface StatusRouteDeps {
  repository: AccommodationRepository;
}

export function registerStatusRoute(app: FastifyInstance, { repository }: StatusRouteDeps): void {
  app.get<{ Params: { id: string } }>('/accommodations/:id/sync-status', async (request, reply) => {
    const doc = await repository.findById(request.params.id);
    if (doc === null) {
      return reply.code(404).send(errorBody('NOT_FOUND', 'Nunca se ha recibido un update de este alojamiento'));
    }
    return reply.code(200).send(toSyncStatus(doc, now()));
  });
}

/** Todos los campos aparecen siempre; los días anteriores a hoy no cuentan como pendientes. */
function toSyncStatus(doc: AccommodationDoc, at: Date): SyncStatusResponse {
  // Agrupados como se enviarán, también en `error`.
  const pendingRanges = groupPendingRanges(doc.days, todayUtc(at));
  const pendingDays = pendingRanges.reduce((total, range) => total + daysInRange(range.from, range.to), 0);
  return {
    accommodationId: doc._id,
    status: doc.status,
    pendingDays,
    pendingSince: isoOrNull(doc.pendingSince),
    pendingRanges,
    attempts: doc.attempts,
    nextAttemptAt: isoOrNull(doc.nextAttemptAt),
    lastError:
      doc.lastError === null
        ? null
        : { code: doc.lastError.code, message: doc.lastError.message, at: doc.lastError.at.toISOString() },
    lastSyncedAt: isoOrNull(doc.lastSyncedAt),
  };
}

function isoOrNull(instant: Date | null): string | null {
  return instant === null ? null : instant.toISOString();
}
