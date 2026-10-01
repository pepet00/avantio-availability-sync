// `POST /updates`: valida el update, lo guarda y solo entonces responde `202` (invariante 1).

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { now } from '../clock.js';
import { todayUtc } from '../dates.js';
import { errorBody, isBodyParseError } from '../errors.js';
import type { AccommodationRepository } from '../storage/repository.js';
import type { UpdateConfig } from '../sync/state.js';
import { validateUpdate } from './validation.js';

export interface UpdatesRouteDeps {
  repository: AccommodationRepository;
  config: UpdateConfig;
}

export function registerUpdatesRoute(app: FastifyInstance, { repository, config }: UpdatesRouteDeps): void {
  app.post('/updates', {
    // El JSON mal formado no llega al handler: también es un update rechazado.
    onError: (request, _reply, error, done) => {
      if (isBodyParseError(error)) {
        request.log.info({ event: 'update.rejected', errorCode: 'INVALID_BODY' }, 'Update rechazado');
      }
      done();
    },
    handler: async (request, reply) => {
      const result = validateUpdate(request.body, todayUtc(now()));
      if (!result.ok) {
        request.log.info({ event: 'update.rejected', errorCode: result.code }, 'Update rechazado');
        return reply.code(400).send(errorBody(result.code, result.message));
      }

      const updateId = randomUUID();
      const { update, days } = result;
      await repository.applyUpdate(update, config);

      request.log.info({ event: 'update.accepted', updateId, ...update, days }, 'Update aceptado');
      return reply.code(202).send({
        updateId,
        accommodationId: update.accommodationId,
        from: update.from,
        to: update.to,
        days,
      });
    },
  });
}
