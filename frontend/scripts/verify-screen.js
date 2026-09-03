// Проверка экрана в режиме дизайна: прокрутка, переполнение, мелкий текст.
// Выполняется через javascript_tool после загрузки раздела.
(() => {
  const de = document.documentElement;
  const pageY = de.scrollHeight - de.clientHeight;
  const pageX = de.scrollWidth - de.clientWidth;
  const scrollers = [...document.querySelectorAll('*')].filter((e) => {
    const c = getComputedStyle(e);
    const can = /auto|scroll/.test(c.overflow + c.overflowX + c.overflowY);
    return can && (e.scrollHeight - e.clientHeight > 2 || e.scrollWidth - e.clientWidth > 2);
  }).map((e) => ({ cls: (e.className + '').slice(0, 40), dY: e.scrollHeight - e.clientHeight, dX: e.scrollWidth - e.clientWidth }));
  const small = [...document.querySelectorAll('body *')].filter((e) => {
    if (!e.textContent || !e.textContent.trim()) return false;
    if (e.children.length) return false;
    const fs = parseFloat(getComputedStyle(e).fontSize);
    return fs > 0 && fs < 13;
  }).slice(0, 8).map((e) => ({ t: e.textContent.trim().slice(0, 30), fs: getComputedStyle(e).fontSize }));
  const crash = document.querySelector('.section-crash')?.innerText?.slice(0, 120) || null;
  return JSON.stringify({ url: location.pathname + location.search, win: [innerWidth, innerHeight], pageY, pageX, scrollers: scrollers.slice(0, 6), small, crash });
})();
