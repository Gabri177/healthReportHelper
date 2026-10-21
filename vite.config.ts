import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = 'http://localhost:' + (process.env.API_PORT || 8787);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // keep the browser's Host so share links point at this origin, not the API port
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '^/r/': { target: api, changeOrigin: false },
    },
  },
});
