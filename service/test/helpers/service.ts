// Servicio arrancado de verdad (HTTP en un puerto libre) contra el MongoDB en memoria.
// Usa el reloj del servicio: los tests lo controlan con advanceClock/resetClock.

import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { connectStorage, type Storage } from '../../src/storage/mongo.js';
import { AccommodationRepository } from '../../src/storage/repository.js';
import { captureLogs, type LogCapture } from './log-capture.js';

export interface TestService {
  /** URL base, sin barra final. */
  url: string;
  storage: Storage;
  logs: LogCapture;
  close(): Promise<void>;
}

export async function startService(mongoUrl: string, overrides: Partial<Config> = {}): Promise<TestService> {
  const config: Config = { ...loadConfig({}), mongoUrl, port: 0, ...overrides };
  const storage = await connectStorage(config.mongoUrl);
  const logs = captureLogs();
  const app = buildApp(config, { repository: new AccommodationRepository(storage.accommodations), logger: logs.logger });
  try {
    await app.listen({ host: '127.0.0.1', port: config.port });
  } catch (error) {
    await storage.close();
    throw error;
  }
  const address = app.server.address();
  if (typeof address !== 'object' || address === null) throw new Error('El servicio no escucha en un puerto TCP');

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    storage,
    logs,
    close: async () => {
      await app.close();
      await storage.close();
    },
  };
}
