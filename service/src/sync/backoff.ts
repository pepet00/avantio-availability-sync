// Retraso de cada reintento tras un `5xx`, `401`, timeout o error de conexión.
// Función pura: el worker lo suma a now() para guardar `nextAttemptAt`; no es un timer.

import type { Config } from '../config.js';

export type BackoffConfig = Pick<Config, 'backoffBaseMs' | 'backoffMaxMs'>;

/** Tope del retraso para el fallo número `attempts` (1 = primer fallo): `min(base × 2^(attempts−1), max)`. */
export function backoffCeilingMs(attempts: number, config: BackoffConfig): number {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`attempts debe ser un entero >= 1: ${String(attempts)}`);
  }
  const { backoffBaseMs, backoffMaxMs } = config;
  if (!(backoffBaseMs >= 0) || !(backoffMaxMs >= 0)) {
    throw new RangeError('El backoff necesita base y tope no negativos');
  }
  if (backoffBaseMs === 0) {
    return 0;
  }
  // Con muchos fallos 2^(attempts−1) llega a Infinity; min() lo deja en el tope.
  return Math.min(backoffBaseMs * 2 ** (attempts - 1), backoffMaxMs);
}

/** *Full jitter*: un retraso al azar entre 0 y el tope. `random` devuelve un valor en [0, 1), como `Math.random`. */
export function backoffDelayMs(
  attempts: number,
  config: BackoffConfig,
  random: () => number = Math.random,
): number {
  const ceiling = backoffCeilingMs(attempts, config);
  const r = random();
  if (!(r >= 0 && r < 1)) {
    throw new RangeError(`La fuente de azar debe devolver un valor en [0, 1): ${String(r)}`);
  }
  return Math.floor(r * ceiling);
}
