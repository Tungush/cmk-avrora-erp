import React from 'react';

/**
 * Сложенный металл — знак проекта (04.09.2026, просьба владельца:
 * «назвать проекты и вместо вышек сделать сложенный металл»).
 *
 * До этого на карточке рисовалась мачта. Она была уместна, пока раздел
 * назывался «Объекты» и означал базовые станции. Но завод делает не
 * только мачты, и раздел стал «Проектами» — знак должен говорить о том,
 * что общего у всех работ, а не об одном виде изделия. Общее — металл
 * в пачке: листы, профиль, швеллер, сложенные на площадке.
 *
 * Готовность показана заливкой снизу вверх: сложено столько листов,
 * сколько изготовлено. Пустые листы остаются контуром — видно и сколько
 * сделано, и сколько всего.
 */
export function MetalStack({
  height = 124,
  layers = 6,
  progress = 0,
  stroke = 1.6,
}: {
  height?: number;
  /** Сколько листов в пачке */
  layers?: number;
  /** 0…1 — доля изготовленного: столько нижних листов залито */
  progress?: number;
  stroke?: number;
}) {
  const w = 64;
  const h = height;
  const gap = 2;
  const sheetH = Math.max(4, (h - gap * (layers - 1) - 6) / layers);
  const done = Math.round(Math.min(1, Math.max(0, progress)) * layers);

  const sheets = Array.from({ length: layers }, (_, i) => {
    // Нижние листы шире: пачка сужается кверху, как реально складывают
    const t = i / Math.max(1, layers - 1);
    const inset = 3 + t * 9;
    const y = h - 3 - (i + 1) * sheetH - i * gap;
    const filled = i < done;
    return (
      <rect
        key={i}
        x={inset}
        y={y}
        width={w - inset * 2}
        height={sheetH}
        rx={Math.min(2, sheetH / 2)}
        className={filled ? 'metal-stack__sheet is-done' : 'metal-stack__sheet'}
        strokeWidth={stroke}
      />
    );
  });

  return (
    <svg
      className="metal-stack"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      fill="none"
      aria-hidden
      focusable="false"
    >
      {sheets}
    </svg>
  );
}
