import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Mirrors NEXT_HARNESS/vitest.config.mts — same "@/*": ["./*"] alias, same
// reasoning (Vite/Vitest don't read tsconfig paths automatically).
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules'],
  },
});
