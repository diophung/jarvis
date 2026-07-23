/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Dev proxy target for the Jarvis API. Follows, in order: JARVIS_API_ORIGIN,
 * the repo root .env's JARVIS_PORT (single source of truth with the server),
 * then the 3001 default.
 */
function apiOrigin(): string {
  if (process.env.JARVIS_API_ORIGIN) return process.env.JARVIS_API_ORIGIN;
  const envFile = resolve(__dirname, '../../.env');
  if (existsSync(envFile)) {
    const match = readFileSync(envFile, 'utf8').match(/^JARVIS_PORT=(\d+)/m);
    if (match) return `http://localhost:${match[1]}`;
  }
  return 'http://localhost:3001';
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiOrigin(),
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: false,
  },
});
