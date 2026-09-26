import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    // Lets you open the dev server from your phone on the same Wi-Fi.
    host: true,
    proxy: {
      '/api': api,
      '/images': api,
    },
  },
});
