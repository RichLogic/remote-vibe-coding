import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function resolveApiBaseUrl(): string {
  const cliPort = process.env.RVC_API_PORT?.trim() || process.env.npm_config_api_port?.trim();

  if (cliPort) {
    return `http://127.0.0.1:${cliPort}`;
  }

  return (process.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': resolveApiBaseUrl(),
    },
  },
});
