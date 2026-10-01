// Lecturas y escrituras de `accommodations_sync`. Las escrituras de estado usan concurrencia
// optimista: solo se aplican si `rev` sigue siendo el leído, y suben `rev`; si otra escritura se
// adelantó, se relee el documento y se recalcula el cambio sobre el estado nuevo. Las del lease
// son atómicas con su propio filtro y no tocan `rev`.

import { MongoServerError, type Collection, type MatchKeysAndValues } from 'mongodb';
import { now } from '../clock.js';
import {
  applyUpdate,
  type AccommodationUpdate,
  type SyncPatch,
  type UpdateConfig,
  type UpdatePatch,
} from '../sync/state.js';
import { SYNC_STATUSES, type AccommodationDoc, type SyncStatus } from './types.js';

const DUPLICATE_KEY = 11000;

export interface Reservation {
  /** El documento ya reservado (con `leaseUntil` puesto). */
  doc: AccommodationDoc & { leaseUntil: Date };
  /** Lease caducado que tenía al reservarlo; `null` si estaba libre. */
  expiredLease: Date | null;
}

export class AccommodationRepository {
  constructor(private readonly accommodations: Collection<AccommodationDoc>) {}

  findById(accommodationId: string): Promise<AccommodationDoc | null> {
    return this.accommodations.findOne({ _id: accommodationId });
  }

  /** Alojamientos con cada estado (índice `{ status: 1 }`). */
  async countByStatus(): Promise<Record<SyncStatus, number>> {
    const counts = await Promise.all(
      SYNC_STATUSES.map(async (status) => [status, await this.accommodations.countDocuments({ status })] as const),
    );
    return Object.fromEntries(counts) as Record<SyncStatus, number>;
  }

  /**
   * El `pendingSince` más viejo entre los alojamientos `pending` y `failing` (índice
   * `{ pending: 1, pendingSince: 1 }`). Excluye `error`, que tiene su propia alerta. `null` si no hay.
   */
  async oldestPendingSince(): Promise<Date | null> {
    const oldest = await this.accommodations.findOne(
      { pending: true, pendingSince: { $ne: null }, status: { $in: ['pending', 'failing'] } },
      { sort: { pendingSince: 1 }, projection: { pendingSince: 1 } },
    );
    return oldest?.pendingSince ?? null;
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

  /**
   * Reserva el alojamiento pendiente cuyo siguiente intento ya ha llegado (el que más espera) y que
   * no tiene un lease activo, fijando `leaseUntil`. `null` si no hay ninguno.
   */
  async reserveNext(at: Date, leaseUntil: Date): Promise<Reservation | null> {
    const previous = await this.accommodations.findOneAndUpdate(
      {
        pending: true,
        nextAttemptAt: { $lte: at },
        $or: [{ leaseUntil: null }, { leaseUntil: { $lte: at } }],
      },
      { $set: { leaseUntil } },
      { sort: { nextAttemptAt: 1 }, returnDocument: 'before' },
    );
    if (previous === null) return null;
    return { doc: { ...previous, leaseUntil }, expiredLease: previous.leaseUntil };
  }

  /** Alarga el lease si sigue siendo `held` y devuelve el documento actual; `null` si se perdió. */
  async renewLease(
    accommodationId: string,
    held: Date,
    leaseUntil: Date,
  ): Promise<(AccommodationDoc & { leaseUntil: Date }) | null> {
    const doc = await this.accommodations.findOneAndUpdate(
      { _id: accommodationId, leaseUntil: held },
      { $set: { leaseUntil } },
      { returnDocument: 'after' },
    );
    return doc === null ? null : { ...doc, leaseUntil };
  }

  /** Libera el lease si sigue siendo `held`. */
  async releaseLease(accommodationId: string, held: Date): Promise<void> {
    await this.accommodations.updateOne({ _id: accommodationId, leaseUntil: held }, { $set: { leaseUntil: null } });
  }

  /**
   * Escribe el resultado del worker. `compute` calcula el cambio sobre el documento leído
   * (`null` si no hay nada que escribir) y se vuelve a llamar con el estado nuevo si otra
   * escritura se adelanta. Devuelve el documento sobre el que se aplicó y el cambio escrito;
   * `null` si no se escribió nada.
   */
  async applySyncResult<P extends SyncPatch>(
    accommodationId: string,
    compute: (current: AccommodationDoc) => P | null,
  ): Promise<{ before: AccommodationDoc; patch: P } | null> {
    for (;;) {
      const current = await this.findById(accommodationId);
      if (current === null) return null;
      const patch = compute(current);
      if (patch === null) return null;

      const result = await this.accommodations.updateOne(
        { _id: current._id, rev: current.rev },
        { $set: syncFields(patch, current.rev + 1) },
      );
      if (result.matchedCount === 1) return { before: current, patch };
    }
  }
}

/** `$set` del resultado del worker: de los días, solo `syncedVersion` de los confirmados. */
function syncFields(patch: SyncPatch, rev: number): MatchKeysAndValues<AccommodationDoc> {
  const { syncedVersions = {}, ...fields } = patch;
  const set: MatchKeysAndValues<AccommodationDoc> = { ...fields, rev };
  for (const [day, version] of Object.entries(syncedVersions)) {
    set[`days.${day}.syncedVersion`] = version;
  }
  return set;
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
