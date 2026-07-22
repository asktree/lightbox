// Dedicated vitest config so tests don't load vite.config.ts (react plugin
// + dev-server proxy). The ENV2 contract test imports the sibling server
// and twinklybox parsers, so allow fs access up to the repo root.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
