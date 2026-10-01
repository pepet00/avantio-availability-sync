// Limitador de peticiones al portal: ventana deslizante y pausa global tras un `429`.
// Ambas son duraciones: se miden con performance.now(), nunca con el reloj del servicio,
// para que adelantar el reloj en un test no vacíe la ventana ni se salte la pausa.

import { setTimeout as delay } from 'node:timers/promises';

// setTimeout no admite más de 2^31−1 ms; las esperas más largas se hacen en varios tramos.
const MAX_TIMER_MS = 2_147_483_647;

export interface LimiterOptions {
  /** Peticiones máximas en cualquier ventana. */
  limit: number;
  /** Longitud de la ventana. */
  windowMs: number;
}

export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  /** Instantes monótonos de las peticiones de la ventana actual, del más antiguo al más reciente. */
  private readonly sent: number[] = [];
  private pausedUntil = 0;

  constructor({ limit, windowMs }: LimiterOptions) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`El límite debe ser un entero >= 1: ${String(limit)}`);
    }
    if (!(windowMs > 0)) {
      throw new RangeError(`La ventana debe ser mayor que 0: ${String(windowMs)}`);
    }
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /**
   * Espera hasta que se pueda enviar una petición y la anota en la ventana.
   * Si `signal` se aborta durante la espera, rechaza sin anotar nada.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const t = performance.now();
      const wait = this.waitMs(t);
      if (wait <= 0) {
        // Comprobar y anotar ocurre sin ceder el control: dos llamadas no pueden colarse a la vez.
        this.sent.push(t);
        return;
      }
      // Al despertar se vuelve a comprobar: otra llamada pudo ocupar el hueco o alargar la pausa.
      await delay(Math.min(Math.ceil(wait), MAX_TIMER_MS), undefined, { signal });
    }
  }

  /** Pausa global: nada se envía hasta que pasen `ms`. Nunca acorta una pausa ya en curso. */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, performance.now() + ms);
  }

  private waitMs(t: number): number {
    while (this.sent.length > 0 && t - (this.sent[0] ?? t) >= this.windowMs) {
      this.sent.shift();
    }
    const pauseWait = this.pausedUntil - t;
    const oldest = this.sent[0];
    const windowWait = this.sent.length < this.limit || oldest === undefined ? 0 : oldest + this.windowMs - t;
    return Math.max(pauseWait, windowWait);
  }
}
