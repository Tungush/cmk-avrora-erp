import axios from 'axios';
import { useAuthStore } from '../store/auth';
import { API_BASE, IS_CROSS_ORIGIN } from './base';
import { isDesignMode, designAdapter } from '../dev/designMode';

// Через интернет (фронт на Vercel, бэкенд на VPS) 2 с мало: к времени
// запроса добавляются RTT и TLS-хендшейк. На том же origin оставляем
// прежние 2 с — там медленный ответ означает проблему, а не сеть.
const API_TIMEOUT_MS = IS_CROSS_ORIGIN ? 15000 : 2000;

const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
  timeout: API_TIMEOUT_MS,
  // Режим дизайна (?design=1): ответы из фикстур, бэкенд не нужен
  ...(isDesignMode() ? { adapter: designAdapter } : {}),
});

// Attach JWT token to every request
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle 401 → logout
api.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().logout();
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;
