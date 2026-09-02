import { useEffect } from 'react';

/**
 * Слой света (02.09.2026).
 *
 * Под интерфейсом медленно дышит градиентное сияние, а панели — матовое
 * стекло, сквозь которое оно видно. За курсором идёт тёплое пятно, и
 * стеклянные поверхности ловят его кромкой: интерфейс ощущается
 * материалом, а не картинкой.
 *
 * Всё держится на двух CSS-переменных, которые пишет ОДИН обработчик
 * указателя: React при движении мыши не перерисовывается вовсе.
 */

/** Пишет --cursor-x/--cursor-y холсту и --mx/--my стеклу под курсором */
export function useCursorLight() {
  useEffect(() => {
    if (window.matchMedia('(pointer: coarse)').matches) return; // на тач-экране света нет
    const root = document.documentElement;
    let raf = 0;
    let x = 0;
    let y = 0;
    let lit: HTMLElement | null = null;

    const paint = () => {
      raf = 0;
      root.style.setProperty('--cursor-x', `${x}px`);
      root.style.setProperty('--cursor-y', `${y}px`);
      if (lit) {
        const r = lit.getBoundingClientRect();
        lit.style.setProperty('--mx', `${x - r.left}px`);
        lit.style.setProperty('--my', `${y - r.top}px`);
      }
    };

    const onMove = (e: PointerEvent) => {
      x = e.clientX;
      y = e.clientY;
      const target = e.target as Element | null;
      // Стеклянная поверхность под курсором: карточка, панель входа
      const next = target?.closest?.('.mantine-Card-root, .glass-lit, .login-card') as HTMLElement | null;
      if (next !== lit) {
        lit?.style.removeProperty('--mx');
        lit?.style.removeProperty('--my');
        lit = next;
      }
      if (!raf) raf = requestAnimationFrame(paint);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
}

/** Градиентное сияние под всем приложением + свет за курсором */
export function AuroraCanvas() {
  useCursorLight();
  return (
    <div className="aurora-canvas" aria-hidden>
      <div className="aurora-canvas__blob aurora-canvas__blob--warm" />
      <div className="aurora-canvas__blob aurora-canvas__blob--deep" />
      <div className="aurora-canvas__blob aurora-canvas__blob--cool" />
      <div className="aurora-canvas__cursor" />
    </div>
  );
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
