import { fastify, LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { handleFrameworkError, logHttpRequest, registerErrorHandlers } from './errors.js';
import type { AccommodationRepository } from './storage/repository.js';
import { registerUpdatesRoute } from './updates/route.js';

export interface AppDeps {
  repository: AccommodationRepository;
  /** Solo para tests: logger que escribe en memoria. Por defecto, `pino` a `LOG_LEVEL`. */
  logger?: FastifyBaseLogger;
}

export function buildApp(config: Config, { repository, logger }: AppDeps): FastifyInstance {
  // Los logs de petición de Fastify no llevan `event`: se sustituyen por http.request.
  const options = {
    logController: new LogController({ disableRequestLogging: true }),
    frameworkErrors: handleFrameworkError,
  };
  const app =
    logger === undefined
      ? fastify({ ...options, logger: { level: config.logLevel } })
      : fastify({ ...options, loggerInstance: logger });

  app.addHook('onResponse', (request, reply, done) => {
    logHttpRequest(request, reply);
    done();
  });

  registerErrorHandlers(app);
  registerUpdatesRoute(app, { repository, config });

  return app;
}
