// MongoDB real en memoria para los tests de integración. Cada test conecta a una base nueva:
// parte de cero sin tener que borrar nada, y con los índices recién creados.

import { MongoMemoryServer } from 'mongodb-memory-server';

/** MongoDB 8, la versión del docker-compose (`mongo:8`). */
const MONGO_VERSION = '8.2.6';

export interface TestMongo {
  /** URL de una base que ningún otro test ha usado. */
  freshUrl(): string;
  /** Para el servidor sin borrar sus datos, como una caída. */
  pause(): Promise<void>;
  /** Lo vuelve a arrancar en el mismo puerto y con los datos que tenía. */
  resume(): Promise<void>;
  stop(): Promise<void>;
}

let databases = 0;

export async function startTestMongo(): Promise<TestMongo> {
  const server = await MongoMemoryServer.create({ binary: { version: MONGO_VERSION } });
  return {
    freshUrl: () => server.getUri(`test-${String(++databases)}`),
    pause: async () => {
      await server.stop({ doCleanup: false, force: false });
    },
    resume: () => server.start(true),
    stop: async () => {
      await server.stop();
    },
  };
}
