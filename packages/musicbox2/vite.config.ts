import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Musicbox v2 — client-only. No server of its own:
//   /api/*  → musicbox server (3002): library, stems, envelope
//   :3001   → lightbox server, hit directly (open CORS): autopilot, stem-sync
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // LAN/Tailscale
    port: 5175,
    proxy: {
      '/api': 'http://localhost:3002',
    },
  },
  build: {
    outDir: 'dist',
  },
});
