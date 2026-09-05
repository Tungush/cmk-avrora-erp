/** Деньги → долг по заказам; клик по строке открывает карточку заказа; таблица позиций в карточке */
const m = (b) => b.eval(`(()=>{const rows=document.querySelectorAll('.fin__table tbody tr'); const tiles=[...document.querySelectorAll('.fin .stat')].map(t=>t.querySelector('.stat__value').textContent); const wrap=document.querySelector('.fin__wrap'); return {viewport:[innerWidth,innerHeight], rows:rows.length, tiles, active:document.querySelector('.fin .stat[data-active] .stat__label')?.textContent, tableOverflow:wrap?wrap.scrollWidth-wrap.clientWidth:null, pageScroll:document.documentElement.scrollHeight-innerHeight, small:[...document.querySelectorAll('.fin *')].filter(e=>e.children.length===0&&e.textContent.trim()&&parseFloat(getComputedStyle(e).fontSize)<13).length};})()`);
export default async function (b) {
  const out = {};
  for (const [w, h] of [[1440, 900], [1280, 800]]) {
    await b.viewport(w, h);
    await b.goto('http://localhost:5173/finance?design=1'); await b.waitFor('.fin__table tbody tr'); await b.wait(1800);
    out[`fin${w}`] = await m(b); await b.shot(`finance-${w}.png`);
    const t = await b.rect('.fin .stat', 1); await b.click(t.cx, t.cy); await b.wait(500);
    out[`shipped${w}`] = await m(b);
  }
  await b.viewport(1440, 900);
  const r = await b.rect('.fin__table tbody tr', 0); await b.click(r.cx, r.cy); await b.wait(1500);
  out.card = await b.eval(`(()=>{const d=document.querySelector('.mantine-Drawer-content, .order-full'); const t=document.querySelector('#card-lines table'); const ths=t?[...t.querySelectorAll('th')].map(th=>Math.round(th.getBoundingClientRect().width)):null; return {opened:!!d, linesTable:!!t, thWidths:ths, tableOverflow:t?t.scrollWidth-(t.parentElement?.clientWidth||0):null, sitePlaceholder:!!document.querySelector('#card-lines .peek__inline')};})()`);
  await b.shot('finance-card.png');
  return out;
}
