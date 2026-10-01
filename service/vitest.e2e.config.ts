import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    // Hasta T14 no hay tests E2E.
    passWithNoTests: true,
  },
});
