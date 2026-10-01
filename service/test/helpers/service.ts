// Servicio arrancado de verdad (HTTP en un puerto libre) contra el MongoDB en memoria y, con el
// worker, contra el portal que indique `portalUrl` (el falso). Tiempos cortos de test.
// Usa el reloj del servicio: los tests lo controlan con advanceClock/resetClock.

import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { stopService } from '../../src/lifecycle.js';
import { createMetrics } from '../../src/metrics/registry.js';
import { PortalClient } from '../../src/portal/client.js';
import { connectStorage, type Storage } from '../../src/storage/mongo.js';
import { AccommodationRepository } from '../../src/storage/repository.js';
import { PastDaysSweep } from '../../src/sync/sweep.js';
import { SyncWorker } from '../../src/sync/worker.js';
import { captureLogs, type LogCapture } from './log-capture.js';

export interface TestService {
  /** URL base, sin barra final. */
  url: string;
  storage: Storage;
  logs: LogCapture;
  close(): Promise<void>;
}

export interface ServiceOptions {
  /** Arranca el worker, que envía al portal de `portalUrl`. Sin él, solo la API. */
  worker?: boolean;
  /** Fuente de azar del backoff; fija, para que `nextAttemptAt` sea predecible. */
  random?: () => number;
}

/** Tiempos muy cortos para que los tests no esperen; cada test puede cambiarlos. */
const TEST_TIMINGS: Partial<Config> = {
  portalTimeoutMs: 1_000,
  timeoutGraceMs: 200,
  backoffBaseMs: 20,
  backoffMaxMs: 200,
  workerIdleMs: 10,
};

export async function startService(
  mongoUrl: string,
  overrides: Partial<Config> = {},
  { worker: withWorker = false, random }: ServiceOptions = {},
): Promise<TestService> {
  const config: Config = { ...loadConfig({}), ...TEST_TIMINGS, mongoUrl, port: 0, ...overrides };
  const storage = await connectStorage(config.mongoUrl);
  const logs = captureLogs();
  const repository = new AccommodationRepository(storage.accommodations);
  const metrics = createMetrics();
  const app = buildApp(config, { repository, metrics, logger: logs.logger });
  const sweep = new PastDaysSweep({ repository, logger: logs.logger });
  try {
    // Como src/index.ts: leases sueltos y barrido antes de escuchar y de arrancar el worker.
    await repository.resetLeases();
    await sweep.run();
    await app.listen({ host: '127.0.0.1', port: config.port });
  } catch (error) {
    await storage.close();
    throw error;
  }
  const address = app.server.address();
  if (typeof address !== 'object' || address === null) throw new Error('El servicio no escucha en un puerto TCP');

  const portal = new PortalClient(config, { logger: logs.logger, metrics });
  const worker = new SyncWorker({
    repository,
    portal,
    logger: logs.logger,
    config,
    metrics,
    sweep,
    ...(random && { random }),
  });
  if (withWorker) worker.start();

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    storage,
    logs,
    close: () => stopService({ app, worker, storage }),
  };
}
