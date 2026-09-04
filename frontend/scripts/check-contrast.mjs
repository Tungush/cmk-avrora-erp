/**
 * Проверка контраста палитры по WCAG.
 *
 * Запуск: node scripts/check-contrast.mjs
 *
 * ПОЧЕМУ ПЕРЕПИСАН (05.09.2026). В прежней версии цвета были вшиты в
 * сам скрипт списком: #F8F8F7, #17314D, #B23A2C, #134C34 и ещё десять.
 * После смены палитры ни одного из них не осталось в tokens.css — и
 * скрипт продолжал проходить, проверяя цвета, которых нет. Сторож,
 * который ничего не сторожит, хуже отсутствующего: он даёт ложную
 * уверенность.
 *
 * Теперь значения читаются ИЗ tokens.css с разворачиванием цепочек
 * var(). Скрипт не знает заранее ни одного цвета — он падает, если
 * палитра нарушает правила, и продолжает работать при её замене.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS = join(HERE, '..', 'src', 'styles', 'tokens.css');

/* ── чтение токенов с разворачиванием var() ───────────────────────── */

function readTokens() {
  const css = readFileSync(TOKENS, 'utf8');
  const raw = {};
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    raw[m[1]] = m[2].trim();
  }
  const seen = new Set();
  const resolve = (name, depth = 0) => {
    if (depth > 10) throw new Error(`цикл в var(${name})`);
    const v = raw[name];
    if (!v) return null;
    const ref = v.match(/^var\((--[a-z0-9-]+)\)$/i);
    if (ref) return resolve(ref[1], depth + 1);
    const hex = v.match(/^#[0-9a-f]{3,8}$/i);
    return hex ? v.toUpperCase() : null;
  };
  const out = {};
  for (const name of Object.keys(raw)) {
    const v = resolve(name);
    if (v) { out[name] = v; seen.add(v); }
  }
  return { tokens: out, distinct: [...seen] };
}

/* ── цвет ─────────────────────────────────────────────────────────── */

const rgb = (h) => {
  const s = h.replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
const lum = (h) => {
  const c = rgb(h).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};
/** Полная потеря цвета: чёрно-белая печать, монохромная панель в цеху */
const desaturate = (h) => {
  const [r, g, b] = rgb(h);
  const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  return `#${[y, y, y].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};
/** Хроматичность: насколько цвет вообще цветной, а не серый */
const chroma = (h) => {
  const [r, g, b] = rgb(h);
  return Math.max(r, g, b) - Math.min(r, g, b);
};

/* ── правила ──────────────────────────────────────────────────────── */

const { tokens, distinct } = readTokens();
const T = (n) => {
  const v = tokens[n];
  if (!v) throw new Error(`токена ${n} нет в tokens.css — проверка не может считаться пройденной`);
  return v;
};

const SURFACES = [
  ['карточка', '--s-surface'],
  ['холст', '--s-bg'],
  ['вложенное', '--s-surface-quiet'],
];
const TEXT = [
  ['основной текст', '--s-text'],
  ['вторичный текст', '--s-text-quiet'],
];

const fails = [];
const warns = [];
const ok = [];

/* 1. Текст на каждой поверхности — 4,5:1 */
for (const [tn, tk] of TEXT) {
  for (const [sn, sk] of SURFACES) {
    const r = contrast(T(tk), T(sk));
    const line = `${tn} на «${sn}»: ${r.toFixed(2)}:1`;
    (r >= 4.5 ? ok : fails).push(r >= 4.5 ? line : `${line} — нужно 4,5`);
  }
}

/* 2. Светлый текст на тёмной плитке */
{
  const r = contrast(T('--s-text-on-panel'), T('--s-panel'));
  const line = `текст на тёмной плитке: ${r.toFixed(2)}:1`;
  (r >= 4.5 ? ok : fails).push(r >= 4.5 ? line : `${line} — нужно 4,5`);
}

/* 3. Разделение поверхностей: карточка без рамки держится яркостью */
{
  const r = contrast(T('--s-surface'), T('--s-bg'));
  const line = `разделение карточка/холст: ${r.toFixed(3)}`;
  if (r < 1.08) fails.push(`${line} — меньше 1,08, карточка растворяется`);
  else ok.push(line);
}

/* 4. Волосяная линия должна быть видна на обеих поверхностях */
for (const [sn, sk] of [['карточке', '--s-surface'], ['холсте', '--s-bg']]) {
  const r = contrast(T('--s-line'), T(sk));
  const line = `разделитель на ${sn}: ${r.toFixed(2)}:1`;
  if (r < 1.35) fails.push(`${line} — линии не видно`);
  else if (r < 1.5) warns.push(`${line} — на грани`);
  else ok.push(line);
}

/* 5. Сигнал должен переживать полную потерю цвета */
{
  const sig = T('--s-attention');
  for (const [sn, sk] of SURFACES) {
    const r = contrast(desaturate(sig), desaturate(T(sk)));
    const line = `сигнал без цвета (ч/б) на «${sn}»: ${r.toFixed(2)}:1`;
    if (r < 3) fails.push(`${line} — при потере цвета сигнал исчезает`);
    else ok.push(line);
  }
}

/* 6. Бюджет палитры: цветов мало, хроматических — единицы */
{
  const chromatic = distinct.filter((h) => chroma(h) > 30);
  ok.push(`различных цветов в токенах: ${distinct.length}`);
  if (distinct.length > 12) fails.push(`цветов ${distinct.length} — больше 12, палитра расползлась`);
  ok.push(`из них хроматических: ${chromatic.length} (${chromatic.join(', ') || 'нет'})`);
  if (chromatic.length > 2) fails.push(`хроматических ${chromatic.length} — указатель должен быть один`);
}

/* ── вывод ────────────────────────────────────────────────────────── */

console.log('Проверка контраста — значения прочитаны из tokens.css\n');
for (const l of ok) console.log(`  ok    ${l}`);
for (const l of warns) console.log(`  ~     ${l}`);
for (const l of fails) console.log(`  ПЛОХО ${l}`);

if (fails.length) {
  console.error(`\nНарушений: ${fails.length}`);
  process.exit(1);
}
console.log(`\nВсё сходится${warns.length ? `, предупреждений: ${warns.length}` : ''}.`);
