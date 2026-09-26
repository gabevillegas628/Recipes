import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 127.0.0.1, not localhost: Node may resolve localhost to ::1, where another dev server can be listening.
const api = 'http://127.0.0.1:3000';

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
