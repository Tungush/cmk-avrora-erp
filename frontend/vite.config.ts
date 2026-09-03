import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Пакета @types/node в проекте нет, а конфиг Vite исполняется в Node.
// Объявляем ровно то, чем пользуемся, — это дешевле, чем тянуть
// зависимость ради одной переменной окружения.
declare const process: { env: Record<string, string | undefined> };

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Порт берётся из PORT, когда его назначает окружение (например
    // предпросмотр Claude Code выбирает свободный, если 5173 уже занят
    // другим сервером разработки). Для `npm run dev` руками остаётся
    // привычный 5173.
    //
    // Закреплять 5173 незачем: браузер ходит только на origin самого
    // Vite, а до Go-бэкенда запросы идут через прокси ниже. Кросс-
    // доменных обращений нет, поэтому и в CORS этот порт не прописан.
    port: Number(process.env.PORT) || 5173,
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
