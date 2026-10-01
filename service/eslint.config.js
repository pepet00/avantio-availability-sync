import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['node_modules/', 'coverage/', 'dist/'] },
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Regla de CLAUDE.md: los instantes salen del módulo de reloj; las fechas, del de fechas.
    files: ['src/**/*.ts'],
    ignores: ['src/clock.ts', 'src/dates.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'Los instantes salen de src/clock.ts y las fechas de calendario de src/dates.ts.',
        },
        {
          selector: "CallExpression[callee.name='Date']",
          message: 'Los instantes salen de src/clock.ts.',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Usa now() de src/clock.ts para instantes y performance.now() para duraciones.',
        },
      ],
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
