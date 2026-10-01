// Único origen de los instantes del servicio ("hoy", nextAttemptAt, leaseUntil, pendingSince).
// Las duraciones no salen de aquí: se miden con performance.now() o timers.

let offsetMs = 0;

export function now(): Date {
  return new Date(Date.now() + offsetMs);
}

/** Instante desplazado `ms` milisegundos (por ejemplo, `nextAttemptAt = now() + margen`). */
export function addMs(instant: Date, ms: number): Date {
  return new Date(instant.getTime() + ms);
}

/** Solo para tests: adelanta el reloj sin congelarlo; sigue avanzando con la hora real. */
export function advanceClock(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`El reloj solo se adelanta: ${String(ms)} ms no es válido`);
  }
  offsetMs += ms;
}

/** Solo para tests: vuelve a la hora real. */
export function resetClock(): void {
  offsetMs = 0;
}
