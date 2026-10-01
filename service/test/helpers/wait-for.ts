// Espera por condición con tiempo máximo, en lugar de sleeps fijos.

export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Qué se esperaba, para el mensaje de error. */
  message?: string;
}

/**
 * Repite `check` hasta que devuelva algo distinto de `undefined`, `null` o `false`, y lo devuelve.
 * Si `check` lanza, se trata como "aún no". Falla al pasar `timeoutMs`, con el último error si lo hubo.
 */
export async function waitFor<T>(
  check: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  { timeoutMs = 5_000, intervalMs = 10, message = 'la condición' }: WaitForOptions = {},
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined && value !== null && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    if (performance.now() >= deadline) {
      const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new Error(`No se cumplió ${message} en ${String(timeoutMs)} ms${detail}`, { cause: lastError });
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
