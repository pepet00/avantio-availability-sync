// Métricas Prometheus del servicio, más las del proceso Node. Un registro por servicio, no el global
// de `prom-client`: así dos servicios en el mismo proceso (los tests) no comparten contadores.
// Ninguna métrica lleva `accommodationId`: con miles de alojamientos generaría miles de series.

import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { PortalOutcome } from '../portal/client.js';
import type { RetryableOutcome } from '../sync/state.js';

/** Buckets de latencia en segundos, hasta el timeout por petición (15 s). */
const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15];

export interface Metrics {
  registry: Registry;
  /** Trabajo pendiente: alojamientos por estado. Se fija desde MongoDB en cada consulta. */
  accommodationsByStatus: Gauge<'status'>;
  /** Antigüedad del `pendingSince` más viejo entre `pending` y `failing`. Se fija en cada consulta. */
  oldestPendingAge: Gauge;
  portalRequests: Counter<'method' | 'outcome'>;
  portalRequestDuration: Histogram<'method' | 'outcome'>;
  syncRetries: Counter<'reason'>;
}

/** Lo que registra el cliente del portal en cada llamada. */
export type PortalMetrics = Pick<Metrics, 'portalRequests' | 'portalRequestDuration'>;

/** Lo que registra el worker en cada reintento. */
export type WorkerMetrics = Pick<Metrics, 'syncRetries'>;

export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const registers = [registry];

  return {
    registry,
    accommodationsByStatus: new Gauge({
      name: 'sync_accommodations_by_status',
      help: 'Alojamientos por estado de sincronización',
      labelNames: ['status'],
      registers,
    }),
    oldestPendingAge: new Gauge({
      name: 'sync_oldest_pending_age_seconds',
      help: 'Antigüedad del pendingSince más viejo entre pending y failing (0 si no hay)',
      registers,
    }),
    portalRequests: new Counter({
      name: 'portal_requests_total',
      help: 'Llamadas al portal por método y resultado',
      labelNames: ['method', 'outcome'],
      registers,
    }),
    portalRequestDuration: new Histogram({
      name: 'portal_request_duration_seconds',
      help: 'Latencia de las llamadas al portal',
      labelNames: ['method', 'outcome'],
      buckets: DURATION_BUCKETS,
      registers,
    }),
    syncRetries: new Counter({
      name: 'sync_retries_total',
      help: 'Reintentos programados por motivo',
      labelNames: ['reason'],
      registers,
    }),
  };
}

export function recordPortalRequest(
  metrics: PortalMetrics,
  method: 'PUT',
  outcome: PortalOutcome,
  durationMs: number,
): void {
  const labels = { method, outcome };
  metrics.portalRequests.inc(labels);
  metrics.portalRequestDuration.observe(labels, durationMs / 1000);
}

/** El motivo del reintento es el resultado reintentable del portal. */
export function recordRetry(metrics: WorkerMetrics, reason: RetryableOutcome): void {
  metrics.syncRetries.inc({ reason });
}
