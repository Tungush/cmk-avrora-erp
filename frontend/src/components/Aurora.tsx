import { useEffect } from 'react';

/**
 * Фон приложения (04.09.2026).
 *
 * Раньше здесь жил слой света: за курсором шло размытое пятно, а
 * стеклянные поверхности ловили его кромкой. Владелец попросил убрать —
 * и правильно: пятно двигалось всё время, пока рука на мыши, то есть
 * нарушало правило «ничего не движется в покое», и заставляло глаз
 * следить за собой вместо данных. Обработчик pointermove снят целиком:
 * на каждое движение мыши больше не пишутся CSS-переменные и не
 * запускается кадр анимации.
 */
export function AuroraCanvas() {
  return null;
}

/**
 * Магнитная кнопка: элемент слегка тянется к курсору. Смещение маленькое
 * (до 6 px) — это отклик материала, а не «прыгающая кнопка».
 */
export function useMagnetic(ref: React.RefObject<HTMLElement | null>, strength = 6) {
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia('(pointer: coarse)').matches) return;
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
      const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      el.style.transform = `translate3d(${dx * strength}px, ${dy * strength}px, 0)`;
    };
    const reset = () => { el.style.transform = ''; };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', reset);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', reset);
      reset();
    };
  }, [ref, strength]);
}
