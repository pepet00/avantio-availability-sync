// MongoDB real en memoria para los tests de integración. Cada test conecta a una base nueva:
// parte de cero sin tener que borrar nada, y con los índices recién creados.

import { MongoMemoryServer } from 'mongodb-memory-server';

/** MongoDB 8, la versión del docker-compose (`mongo:8`). */
const MONGO_VERSION = '8.2.6';

export interface TestMongo {
  /** URL de una base que ningún otro test ha usado. */
  freshUrl(): string;
  stop(): Promise<void>;
}

let databases = 0;

export async function startTestMongo(): Promise<TestMongo> {
  const server = await MongoMemoryServer.create({ binary: { version: MONGO_VERSION } });
  return {
    freshUrl: () => server.getUri(`test-${String(++databases)}`),
    stop: async () => {
      await server.stop();
    },
  };
}
