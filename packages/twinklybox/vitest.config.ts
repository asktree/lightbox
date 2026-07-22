// Dedicated vitest config so tests don't load vite.config.ts (react plugin
// + dev-server proxy).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
