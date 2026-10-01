import { fastify, LogController, type FastifyInstance } from 'fastify';
import type { Config } from './config.js';

export function buildApp(config: Config): FastifyInstance {
  // Los logs de petición de Fastify no llevan `event`: se sustituyen por http.request.
  const app = fastify({
    logger: { level: config.logLevel },
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.addHook('onResponse', (request, reply, done) => {
    request.log.info(
      {
        event: 'http.request',
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'Petición atendida',
    );
    done();
  });

  return app;
}
