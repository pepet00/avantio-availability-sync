// Conexión a MongoDB e índices de `accommodations_sync`.

import { MongoClient, type Collection } from 'mongodb';
import type { AccommodationDoc } from './types.js';

export const ACCOMMODATIONS_COLLECTION = 'accommodations_sync';

export interface Storage {
  client: MongoClient;
  accommodations: Collection<AccommodationDoc>;
  close(): Promise<void>;
}

/** Conecta a la base de la URL y crea los índices si no existen. */
export async function connectStorage(url: string): Promise<Storage> {
  const client = new MongoClient(url);
  await client.connect();
  try {
    const accommodations = client.db().collection<AccommodationDoc>(ACCOMMODATIONS_COLLECTION);
    await ensureIndexes(accommodations);
    return { client, accommodations, close: () => client.close() };
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function ensureIndexes(accommodations: Collection<AccommodationDoc>): Promise<void> {
  await accommodations.createIndexes([
    // Worker: alojamientos con pendientes cuyo siguiente intento ya ha llegado.
    { key: { pending: 1, nextAttemptAt: 1 } },
    // Métricas: alojamientos por estado y antigüedad del pendiente más viejo.
    { key: { status: 1 } },
    { key: { pending: 1, pendingSince: 1 } },
  ]);
}
