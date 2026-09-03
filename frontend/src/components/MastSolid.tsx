import React, { useId } from 'react';

/**
 * Вышка плотным силуэтом (04.09.2026).
 *
 * Владелец прислал рисунок и попросил «заменить вышку на такой стиль на
 * главном экране и везде»: плотная заливка, жирный тёмный контур,
 * маячок сверху, дуги сигнала по бокам.
 *
 * Прежняя вышка была решётчатой — тонкие линии фермы. На крупном экране
 * входа это читалось, но в карточке 72 px решётка сливалась в серое
 * пятно. Плотный силуэт узнаётся на любом размере, а решётку всё равно
 * никто не разглядывал.
 *
 * Штриховку из присланного рисунка намеренно НЕ повторяю: на 44 px она
 * превращается в грязь, а рядом с ровными линиями интерфейса выглядит
 * инородно. Взята суть стиля — силуэт, контур, маячок.
 *
 * Готовность заливается снизу вверх: сколько изделий площадки сдано,
 * настолько вышка «выросла». Цвета — из палитры через CSS, чтобы знак
 * пережил смену палитры без правки кода.
 */
export function MastSolid({
  height = 120,
  progress = 0,
  signal = true,
  onDark = false,
  className,
}: {
  height?: number;
  /** 0…1 — доля сданного: настолько силуэт залит снизу */
  progress?: number;
  /** Дуги сигнала по бокам маячка */
  signal?: boolean;
  /** На тёмной подложке контур и заливка меняются местами по светлоте */
  onDark?: boolean;
  className?: string;
}) {
  const clipId = useId();
  const W = 96;
  const H = 128;
  const sw = 3.2;

  const topY = 34;
  const botY = 104;
  const topHalf = 6;
  const botHalf = 22;
  const cx = 48;

  const p = Math.min(1, Math.max(0, progress));
  const fillY = botY - (botY - topY) * p;
  const body = `M ${cx - topHalf} ${topY} L ${cx + topHalf} ${topY} L ${cx + botHalf} ${botY} L ${cx - botHalf} ${botY} Z`;

  return (
    <svg
      className={['mast-solid', className].filter(Boolean).join(' ')}
      data-on-dark={onDark ? 'true' : undefined}
      width={height * (W / H)}
      height={height}
      viewBox={`0 0 ${W} ${H}`}
      fill="none"
      aria-hidden
      focusable="false"
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={0} y={fillY} width={W} height={botY - fillY} />
        </clipPath>
      </defs>

      {signal && (
        <g strokeWidth={sw} strokeLinecap="round">
          <path d="M30 14 a14 14 0 0 0 0 18" className="ms-wave" />
          <path d="M22 8 a22 22 0 0 0 0 30" className="ms-wave" />
          <path d="M66 14 a14 14 0 0 1 0 18" className="ms-wave" />
          <path d="M74 8 a22 22 0 0 1 0 30" className="ms-wave" />
        </g>
      )}

      {/* Тело: светлая основа, поверх — залитая доля, сверху общий контур.
          Три слоя, а не один с двумя заливками: иначе контур пришлось бы
          рисовать дважды и он утолщался бы по краю залитой части. */}
      <path d={body} className="ms-fill" />
      <path d={body} className="ms-fill is-done" clipPath={`url(#${clipId})`} />
      <path d={body} className="ms-outline" strokeWidth={sw} />

      <rect x={20} y={botY} width={56} height={13} rx={5} className="ms-base" strokeWidth={sw} />
      <circle cx={cx} cy={20} r={12} className="ms-beacon" strokeWidth={sw} />
    </svg>
  );
}
