import { buildApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './config.js';

// La configuración se carga antes de nada: con un valor inválido, el servicio no arranca.
// El error va a stderr en texto plano porque el logger depende de esta misma configuración.
let config: Config;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

const app = buildApp(config);
await app.ready();

// Fastify escribe "Server listening at …" sin `event` y sin opción para quitarlo:
// se silencia el logger solo durante listen y se registra server.started en su lugar.
app.log.level = 'silent';
try {
  await app.listen({ host: '0.0.0.0', port: config.port });
} finally {
  app.log.level = config.logLevel;
}

const address = app.server.address();
const port = typeof address === 'object' && address !== null ? address.port : config.port;
app.log.info({ event: 'server.started', port }, 'Servicio escuchando');
