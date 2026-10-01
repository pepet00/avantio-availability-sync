// Errores del servicio con la misma forma que los del portal: `{ "error": { "code", "message" } }`.

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  MongoNetworkError,
  MongoNotConnectedError,
  MongoServerSelectionError,
  MongoTopologyClosedError,
} from 'mongodb';

export interface ErrorBody {
  error: { code: string; message: string };
}

export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

/** Error al leer el cuerpo: JSON mal formado o vacío, `Content-Type` que no es JSON, cuerpo demasiado grande. */
export function isBodyParseError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('FST_ERR_CTP_')
  );
}

/**
 * MongoDB no responde (caído, sin red o sin servidor que seleccionar). Un error del propio
 * servidor (por ejemplo, un documento rechazado) no lo es: es un fallo interno.
 */
export function isStorageUnavailable(error: unknown): boolean {
  return (
    error instanceof MongoNetworkError ||
    error instanceof MongoServerSelectionError ||
    error instanceof MongoNotConnectedError ||
    error instanceof MongoTopologyClosedError
  );
}

/** Evento `http.request`: una línea por petición atendida. */
export function logHttpRequest(request: FastifyRequest, reply: FastifyReply): void {
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
}

/**
 * Errores que Fastify detecta antes de buscar la ruta y no pasan por el manejador de errores
 * (opción `frameworkErrors`). Una URL mal codificada (`%zz`) no corresponde a ninguna ruta: `404`.
 */
export function handleFrameworkError(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  // Aquí no se ejecuta el hook onResponse: http.request se registra a mano.
  reply.raw.once('finish', () => {
    logHttpRequest(request, reply);
  });
  if (error.code === 'FST_ERR_BAD_URL') {
    void reply.code(404).send(errorBody('NOT_FOUND', 'Ruta no encontrada'));
    return;
  }
  request.log.error({ event: 'http.internal_error', err: error }, 'Error interno');
  void reply.code(500).send(errorBody('INTERNAL_ERROR', 'Error interno'));
}

/** Manejador de errores y de rutas inexistentes. Nunca devuelve detalles internos. */
export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send(errorBody('NOT_FOUND', 'Ruta no encontrada'));
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (isBodyParseError(error)) {
      return reply.code(400).send(errorBody('INVALID_BODY', 'El cuerpo debe ser JSON válido con Content-Type: application/json'));
    }
    if (isStorageUnavailable(error)) {
      request.log.error({ event: 'http.storage_unavailable', err: error }, 'MongoDB no disponible');
      return reply.code(503).send(errorBody('STORAGE_UNAVAILABLE', 'Almacenamiento no disponible'));
    }
    request.log.error({ event: 'http.internal_error', err: error }, 'Error interno');
    return reply.code(500).send(errorBody('INTERNAL_ERROR', 'Error interno'));
  });
}
