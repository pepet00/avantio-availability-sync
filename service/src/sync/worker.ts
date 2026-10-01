// Worker: envía al portal los rangos pendientes de cada alojamiento, reservándolo con un lease.
// Bucle en el mismo proceso que el servidor HTTP. El ritmo lo marca el limitador del cliente,
// no el bucle: tras un alojamiento sigue con el siguiente sin esperar; sin trabajo, duerme.

import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyBaseLogger } from 'fastify';
import { addMs, now } from '../clock.js';
import type { Config } from '../config.js';
import { todayUtc } from '../dates.js';
import type { PortalClient, PortalError } from '../portal/client.js';
import type { AccommodationRepository } from '../storage/repository.js';
import { groupPendingRanges } from './grouping.js';
import { confirmRange, recordFailure, sentVersions, settleWithoutPending } from './state.js';

export type WorkerConfig = Pick<Config, 'leaseMs' | 'workerIdleMs' | 'backoffBaseMs' | 'backoffMaxMs'>;

export interface WorkerDeps {
  repository: AccommodationRepository;
  portal: PortalClient;
  logger: FastifyBaseLogger;
  config: WorkerConfig;
  /** Fuente de azar del backoff, como `Math.random`. */
  random?: () => number;
}

export class SyncWorker {
  private readonly repository: AccommodationRepository;
  private readonly portal: PortalClient;
  private readonly logger: FastifyBaseLogger;
  private readonly config: WorkerConfig;
  private readonly random: () => number;
  private controller = new AbortController();
  private running: Promise<void> | null = null;

  constructor({ repository, portal, logger, config, random = Math.random }: WorkerDeps) {
    this.repository = repository;
    this.portal = portal;
    this.logger = logger;
    this.config = config;
    this.random = random;
  }

  start(): void {
    if (this.running !== null) return;
    this.controller = new AbortController();
    this.logger.info({ event: 'worker.started' }, 'Worker arrancado');
    this.running = this.loop(this.controller.signal);
  }

  /**
   * Interrumpe las esperas (sueño del bucle, limitador y pausa), espera a la petición en curso y
   * libera el lease.
   */
  async stop(): Promise<void> {
    if (this.running === null) return;
    this.controller.abort();
    await this.running;
    this.running = null;
    this.logger.info({ event: 'worker.stopped' }, 'Worker parado');
  }

  private async loop(signal: AbortSignal): Promise<void> {
    for (;;) {
      let worked: boolean;
      try {
        worked = await this.syncNext(signal);
      } catch (error) {
        // Una espera interrumpida por la parada no es un fallo.
        if (signal.aborted) return;
        throw error;
      }
      if (!worked) await sleep(this.config.workerIdleMs, signal);
      if (signal.aborted) return;
    }
  }

  /**
   * Reserva un alojamiento y envía sus rangos uno a uno hasta que no quede nada o falle uno.
   * `false` si no había ninguno listo.
   */
  private async syncNext(signal: AbortSignal): Promise<boolean> {
    const reserved = now();
    const reservation = await this.repository.reserveNext(reserved, addMs(reserved, this.config.leaseMs));
    if (reservation === null) return false;

    const id = reservation.doc._id;
    if (reservation.expiredLease !== null) {
      this.logger.warn(
        { event: 'worker.lease_expired', accommodationId: id, leaseUntil: reservation.expiredLease.toISOString() },
        'Se retoma un alojamiento con el lease caducado',
      );
    }

    let lease = reservation.doc.leaseUntil;
    try {
      for (;;) {
        // Antes de cada PUT se renueva el lease y se relee el documento: siempre se envía el
        // estado deseado actual (invariante 3).
        const renewedAt = now();
        const renewed = addMs(renewedAt, this.config.leaseMs);
        const current = await this.repository.renewLease(id, lease, renewed);
        if (current === null) return true;
        lease = renewed;

        const [range] = groupPendingRanges(current.days, todayUtc(renewedAt));
        if (range === undefined) {
          await this.repository.applySyncResult(id, (doc) => settleWithoutPending(doc, now()));
          return true;
        }

        const sent = sentVersions(current.days, range);
        const result = await this.portal.put(id, range, { signal });
        const at = now();

        if (result.outcome !== 'success') {
          // Al primer fallo se detiene: los rangos ya confirmados quedan confirmados.
          const error: PortalError =
            result.outcome === 'rate_limited'
              ? { code: 'RATE_LIMITED', message: `El portal pide esperar ${String(result.retryAfterMs / 1000)} s` }
              : result.error;
          await this.repository.applySyncResult(id, (doc) =>
            recordFailure(doc, error, at, this.config, this.random),
          );
          return true;
        }

        await this.repository.applySyncResult(id, (doc) => confirmRange(doc, sent, at));
        this.logger.info(
          {
            event: 'sync.put.succeeded',
            accommodationId: id,
            from: range.from,
            to: range.to,
            status: result.status,
            durationMs: result.durationMs,
          },
          'Rango sincronizado',
        );
      }
    } finally {
      await this.repository.releaseLease(id, lease);
    }
  }
}

/** Espera `ms`; si `signal` se aborta, vuelve antes sin error. */
async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}
