/**
 * Проверка контраста палитры по WCAG (03.09.2026).
 *
 * Запуск: node scripts/check-contrast.mjs
 *
 * Зачем: статья, которую прислал владелец, требует «контраст светлых и
 * тёмных оттенков» и проверку восприятия при цветовой слепоте, а скил
 * ui-ux-pro-max ставит контраст 4,5:1 первым критическим правилом.
 * Считать это на глаз нельзя — считаем формулой WCAG.
 *
 * Дополнительно: пара «просрочено / готово» разводится не только тоном,
 * но и СВЕТЛОТОЙ. Красный и зелёный одной светлоты для дальтоника —
 * один цвет; статья прямо называет это сочетание опасным.
 */

const hex = (h) => {
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};

/** Относительная яркость по WCAG 2.x */
const lum = (h) => {
  const [r, g, b] = hex(h).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const P = {
  cream: '#EAE7DC',
  beige: '#D8C3A5',
  warmGray: '#8E8D8A',
  coral: '#E98074',
  terra: '#E85A4F',
  terraInk: '#AD3828',
  ink: '#33312C',
  muted: '#66625A',
  surface: '#FFFFFF',
  line: '#DCD7C9',
  ok: '#4A5D3A',
  okInk: '#3A4A2D',
};

const checks = [
  ['чернила на кремовом', P.ink, P.cream, 4.5],
  ['чернила на белом', P.ink, P.surface, 4.5],
  ['вторичный на кремовом', P.muted, P.cream, 4.5],
  ['вторичный на белом', P.muted, P.surface, 4.5],
  ['терракота-текст на белом', P.terraInk, P.surface, 4.5],
  ['терракота-текст на кремовом', P.terraInk, P.cream, 4.5],
  ['«готово» на белом', P.ok, P.surface, 4.5],
  ['чернила на беже (панель)', P.ink, P.beige, 4.5],
  ['белый на терракоте (кнопка)', P.surface, P.terra, 3.0],
  ['белый на чернилах (пилюля)', P.surface, P.ink, 4.5],
  ['тёплый серый на кремовом (только линии)', P.warmGray, P.cream, 1.5],
];

let bad = 0;
console.log('\nКОНТРАСТ (WCAG 2.x)');
for (const [name, fg, bg, min] of checks) {
  const r = ratio(fg, bg);
  const ok = r >= min;
  if (!ok) bad += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(42)} ${r.toFixed(2)}:1  (нужно ≥ ${min})`);
}

// Различимость состояний по светлоте: для дальтоника тон не работает
const lTerra = lum(P.terra);
const lOk = lum(P.ok);
const lightnessGap = Math.max(lTerra, lOk) / Math.min(lTerra, lOk);
console.log('\nРАЗЛИЧИМОСТЬ СОСТОЯНИЙ (красный + зелёный — опасная пара)');
console.log(`  просрочено ${P.terra} · яркость ${lTerra.toFixed(3)}`);
console.log(`  готово     ${P.ok} · яркость ${lOk.toFixed(3)}`);
console.log(`  ${lightnessGap >= 2 ? '✓' : '✗'} разница по светлоте ${lightnessGap.toFixed(1)}× (нужно ≥ 2×, иначе для дальтоника это один цвет)`);
if (lightnessGap < 2) bad += 1;

console.log(bad === 0 ? '\nВсё проходит.\n' : `\nПроблем: ${bad}\n`);
process.exit(bad === 0 ? 0 : 1);
