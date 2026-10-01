import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    // Contra el Portal Sol real: latencias de hasta ~10 s, 503 aleatorios y pausas de hasta 60 s por 429.
    testTimeout: 10 * 60_000,
    hookTimeout: 60_000,
  },
});
