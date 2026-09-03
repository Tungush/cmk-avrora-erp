// Ищет места, где текст и числа вылезают за край (03.09.2026).
// Запускается через javascript_tool в режиме дизайна на каждом разделе.
(() => {
  const bad = [];
  const seen = new Set();
  const push = (el, kind, extra) => {
    const key = kind + '|' + (el.className + '').slice(0, 30) + '|' + (el.textContent || '').trim().slice(0, 20);
    if (seen.has(key)) return;
    seen.add(key);
    bad.push({
      kind,
      cls: (el.className + '').slice(0, 46),
      text: (el.textContent || '').trim().slice(0, 40),
      ...extra,
    });
  };

  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;

    // 1. Содержимое шире собственного бокса и НЕ обрезано аккуратно
    const overX = el.scrollWidth - el.clientWidth;
    if (overX > 1 && cs.overflowX === 'visible' && el.children.length === 0) {
      push(el, 'текст шире бокса', { over: overX });
    }
    // 2. Ребёнок вылез за пределы родителя по горизонтали
    const p = el.parentElement;
    if (p && p !== document.body) {
      const pr = p.getBoundingClientRect();
      const ps = getComputedStyle(p);
      if (ps.overflow === 'visible' && ps.overflowX === 'visible') {
        if (r.right > pr.right + 1.5) push(el, 'вылез вправо', { over: Math.round(r.right - pr.right) });
        if (r.bottom > pr.bottom + 1.5 && ps.position !== 'static') {
          push(el, 'вылез вниз', { over: Math.round(r.bottom - pr.bottom) });
        }
      }
    }
    // 3. Текст за правым краем окна
    if (r.right > innerWidth + 1 && el.children.length === 0 && (el.textContent || '').trim()) {
      push(el, 'за краем окна', { over: Math.round(r.right - innerWidth) });
    }
    // 4. Обрезано многоточием — данные не прочитать целиком
    if (el.children.length === 0 && cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 2) {
      push(el, 'обрезано многоточием', { over: el.scrollWidth - el.clientWidth });
    }
  }

  const de = document.documentElement;
  return JSON.stringify({
    url: location.pathname + location.search,
    win: [innerWidth, innerHeight],
    pageY: de.scrollHeight - de.clientHeight,
    pageX: de.scrollWidth - de.clientWidth,
    count: bad.length,
    items: bad.slice(0, 24),
  });
})();
