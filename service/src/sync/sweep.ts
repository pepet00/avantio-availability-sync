// Barrido de días pasados: al arrancar y en cada cambio de día UTC, los alojamientos con pendientes
// cuyos días pendientes ya han pasado quedan sincronizados (también desde `error`). Sin esto, uno
// atascado con días pasados mantendría las alertas encendidas para siempre. Los días no se borran.

import type { FastifyBaseLogger } from 'fastify';
import { now } from '../clock.js';
import { todayUtc, type Day } from '../dates.js';
import type { AccommodationRepository } from '../storage/repository.js';
import { settleWithoutPending } from './state.js';

export interface SweepDeps {
  repository: AccommodationRepository;
  logger: FastifyBaseLogger;
}

export class PastDaysSweep {
  private readonly repository: AccommodationRepository;
  private readonly logger: FastifyBaseLogger;
  /** Día UTC del último barrido completo; `null` si aún no se ha hecho ninguno. */
  private sweptDay: Day | null = null;

  constructor({ repository, logger }: SweepDeps) {
    this.repository = repository;
    this.logger = logger;
  }

  /**
   * Recalcula `pending` y `status` de cada alojamiento con `pending: true` ignorando los días
   * anteriores al día UTC de `at`. Cada escritura lleva la condición de `rev`.
   */
  async run(at: Date = now()): Promise<void> {
    let reviewed = 0;
    let settled = 0;
    for (const id of await this.repository.pendingIds()) {
      reviewed++;
      const applied = await this.repository.applySyncResult(id, (doc) => settleWithoutPending(doc, at));
      if (applied !== null) settled++;
    }
    this.sweptDay = todayUtc(at);
    this.logger.info({ event: 'sweep.completed', reviewed, settled }, 'Barrido de días pasados completado');
  }

  /** Barre si el día UTC de `at` no es el del último barrido. */
  async runIfDayChanged(at: Date = now()): Promise<void> {
    if (todayUtc(at) !== this.sweptDay) await this.run(at);
  }
}
