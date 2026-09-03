import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `--mode roommate` serves the same app on :5176 with .env.roommate applied
// (VITE_LOCKED_ROOM pins the UI to one room for the roommate-facing view).
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    host: true,
    port: mode === 'roommate' ? 5176 : 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
}));
