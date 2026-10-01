// `GET /metrics` en formato Prometheus. Los gauges de trabajo pendiente se calculan desde MongoDB en
// cada consulta, con índice: son correctos desde la primera tras un reinicio. Con MongoDB caído, la
// consulta falla y el manejador de errores responde `503 STORAGE_UNAVAILABLE`.

import type { FastifyInstance } from 'fastify';
import { now } from '../clock.js';
import type { AccommodationRepository } from '../storage/repository.js';
import { SYNC_STATUSES } from '../storage/types.js';
import type { Metrics } from './registry.js';

export interface MetricsRouteDeps {
  repository: AccommodationRepository;
  metrics: Metrics;
}

export function registerMetricsRoute(app: FastifyInstance, { repository, metrics }: MetricsRouteDeps): void {
  app.get('/metrics', async (_request, reply) => {
    const [byStatus, oldestPendingSince] = await Promise.all([
      repository.countByStatus(),
      repository.oldestPendingSince(),
    ]);

    for (const status of SYNC_STATUSES) {
      metrics.accommodationsByStatus.set({ status }, byStatus[status]);
    }
    const ageMs = oldestPendingSince === null ? 0 : Math.max(0, now().getTime() - oldestPendingSince.getTime());
    metrics.oldestPendingAge.set(ageMs / 1000);

    const body = await metrics.registry.metrics();
    return reply.code(200).type(metrics.registry.contentType).send(body);
  });
}
