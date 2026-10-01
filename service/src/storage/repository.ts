// Lecturas y escrituras de `accommodations_sync`. Las escrituras de estado usan concurrencia
// optimista: solo se aplican si `rev` sigue siendo el leído, y suben `rev`; si otra escritura se
// adelantó, se relee el documento y se recalcula el cambio sobre el estado nuevo.

import { MongoServerError, type Collection, type MatchKeysAndValues } from 'mongodb';
import { now } from '../clock.js';
import { applyUpdate, type AccommodationUpdate, type UpdateConfig, type UpdatePatch } from '../sync/state.js';
import type { AccommodationDoc } from './types.js';

const DUPLICATE_KEY = 11000;

export class AccommodationRepository {
  constructor(private readonly accommodations: Collection<AccommodationDoc>) {}

  findById(accommodationId: string): Promise<AccommodationDoc | null> {
    return this.accommodations.findOne({ _id: accommodationId });
  }

  /**
   * Guarda un update. Al resolver, el cambio está escrito en MongoDB (invariante 1).
   * Cada reintento se debe a que otra escritura sí se aplicó, así que el bucle siempre progresa.
   */
  async applyUpdate(update: AccommodationUpdate, config: UpdateConfig): Promise<void> {
    for (;;) {
      const current = await this.findById(update.accommodationId);
      const patch = applyUpdate(current, update, now(), config);

      if (current === null) {
        try {
          await this.accommodations.insertOne(newDocument(update.accommodationId, patch));
          return;
        } catch (error) {
          // Otro update creó el documento a la vez: se reaplica sobre el suyo.
          if (error instanceof MongoServerError && error.code === DUPLICATE_KEY) continue;
          throw error;
        }
      }

      const result = await this.accommodations.updateOne(
        { _id: current._id, rev: current.rev },
        { $set: patchFields(patch, current.rev + 1) },
      );
      if (result.matchedCount === 1) return;
    }
  }
}

function newDocument(accommodationId: string, patch: UpdatePatch): AccommodationDoc {
  return {
    _id: accommodationId,
    seq: patch.seq,
    rev: 1,
    days: patch.days,
    pending: patch.pending,
    pendingSince: patch.pendingSince,
    nextAttemptAt: patch.nextAttemptAt ?? null,
    attempts: patch.attempts ?? 0,
    leaseUntil: null,
    status: patch.status ?? 'synced',
    lastError: null,
    lastSyncedAt: null,
  };
}

/** `$set` con solo los campos del update: los días que cambian uno a uno, nunca `leaseUntil`. */
function patchFields(patch: UpdatePatch, rev: number): MatchKeysAndValues<AccommodationDoc> {
  const { days, ...fields } = patch;
  const set: MatchKeysAndValues<AccommodationDoc> = { ...fields, rev };
  for (const [day, state] of Object.entries(days)) {
    set[`days.${day}`] = state;
  }
  return set;
}
