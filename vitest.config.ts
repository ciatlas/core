import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The tests import the package by its name, as its users do.
    alias: { '@ciatlas/core': fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // @actions/workflow-parser imports JSON without import attributes; let Vite transform it like a bundler does.
    server: { deps: { inline: [/@actions\/workflow-parser/, /@actions\/expressions/] } },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'html', 'json-summary'],
      thresholds: { lines: 95 },
    },
  },
});
