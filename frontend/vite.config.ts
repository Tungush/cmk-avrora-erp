import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        // Локальный Go-бэкенд (backend-go/scripts/dev.sh); в Docker-образе
        // он же слушает :3000 и сам раздаёт этот фронтенд.
        target: 'http://localhost:3100',
        changeOrigin: true,
      },
    },
  },
});
