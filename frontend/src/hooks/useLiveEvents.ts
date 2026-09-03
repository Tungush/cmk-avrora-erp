import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../store/auth';
import { API_BASE } from '../api/base';
import { isDesignMode } from '../dev/designMode';

/**
 * Подписка на живые события (§3.4): пересчёт себестоимости в одном окне
 * сразу обновляет «Спецификации» и «Прайс» в другом — без F5.
 * SSE (EventSource) сам переподключается при обрыве.
 */
export function useLiveCostUpdates() {
  const qc = useQueryClient();
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    if (!token) return;
    // В режиме дизайна бэкенда нет вовсе: без этой проверки страница
    // стучалась на /events/stream и получала 401 (03.09.2026)
    if (isDesignMode()) return;
    const es = new EventSource(`${API_BASE}/events/stream?token=${encodeURIComponent(token)}`);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'article:cost_updated' && msg.articleId) {
          qc.invalidateQueries({ queryKey: ['routing', msg.articleId] });
          qc.invalidateQueries({ queryKey: ['routing-costing', msg.articleId] });
          qc.invalidateQueries({ queryKey: ['routing-costing-history', msg.articleId] });
          qc.invalidateQueries({ queryKey: ['routing-usage', msg.articleId] });
          qc.invalidateQueries({ queryKey: ['articles'] });
          qc.invalidateQueries({ queryKey: ['price-reviews'] });
        }
      } catch {
        /* не-JSON события пропускаем */
      }
    };
    return () => es.close();
  }, [token, qc]);
}
