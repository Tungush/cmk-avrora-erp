import React from 'react';
import { useIsFetching, useIsMutating } from '@tanstack/react-query';

/**
 * Тонкая полоса вверху, пока идут запросы (02.09.2026).
 *
 * Без неё ожидание выглядит как зависание: человек жмёт кнопку второй раз,
 * а на медленной сети — и третий. Полоса не блокирует интерфейс и не
 * перекрывает содержимое: 2 px и никакой модалки.
 *
 * Появляется не мгновенно — быстрые запросы (а их большинство) не должны
 * дёргать экран вспышкой на 80 мс.
 */
export function LoadBar() {
  const fetching = useIsFetching();
  const mutating = useIsMutating();
  const busy = fetching + mutating > 0;
  const [show, setShow] = React.useState(false);

  React.useEffect(() => {
    if (!busy) { setShow(false); return; }
    const t = setTimeout(() => setShow(true), 220);
    return () => clearTimeout(t);
  }, [busy]);

  return <div className="load-bar" data-on={show ? 'true' : undefined} aria-hidden />;
}
