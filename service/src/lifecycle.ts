// Parada ordenada: al recibir SIGTERM o SIGINT se interrumpen las esperas del worker (bucle,
// limitador y pausa), se espera solo a la petición en curso al portal (como máximo su timeout),
// se libera el lease y se cierran el servidor HTTP y la conexión a MongoDB. Si la parada no
// termina en SHUTDOWN_TIMEOUT_MS, el proceso sale igualmente.

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Storage } from './storage/mongo.js';
import type { SyncWorker } from './sync/worker.js';

export interface ServiceParts {
  app: FastifyInstance;
  worker: SyncWorker;
  storage: Storage;
}

/**
 * Cierra el servicio. El worker y el servidor HTTP se paran a la vez (los dos necesitan MongoDB para
 * terminar: el worker para escribir el resultado y liberar el lease, las peticiones en curso para
 * responder); MongoDB se cierra al final.
 */
export async function stopService({ app, worker, storage }: ServiceParts): Promise<void> {
  await Promise.all([worker.stop(), app.close()]);
  await storage.close();
}

export interface ShutdownOptions {
  timeoutMs: number;
  logger: FastifyBaseLogger;
}

/** Para el servicio con SIGTERM o SIGINT y termina el proceso. Una segunda señal no hace nada. */
export function handleShutdownSignals(parts: ServiceParts, { timeoutMs, logger }: ShutdownOptions): void {
  let stopping = false;

  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;

    const timer = setTimeout(() => {
      logger.error({ event: 'server.shutdown_failed', timeoutMs }, 'La parada superó el tiempo máximo');
      process.exit(1);
    }, timeoutMs);

    stopService(parts).then(
      () => {
        clearTimeout(timer);
        process.exit(0);
      },
      (error: unknown) => {
        clearTimeout(timer);
        logger.error({ event: 'server.shutdown_failed', err: error }, 'Error al parar el servicio');
        process.exit(1);
      },
    );
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
