import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: '.',
  server: {
    port: 5180,
    proxy: {
      '/api': 'http://localhost:3010',
      '/ws': { target: 'ws://localhost:3010', ws: true },
    },
  },
  build: {
    outDir: 'dist/client',
  },
});
