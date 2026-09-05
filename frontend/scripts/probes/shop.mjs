/** Цех: список заказов → карточка заказа → назад; Заказы: реестр по умолчанию */
const m = (b) => b.eval(`(()=>{const rows=document.querySelectorAll('.shop-order:not(.shop-order--head)'); const card=document.querySelector('.shop-card'); const wl=document.querySelector('.worklist'); return {viewport:[innerWidth,innerHeight], rows:rows.length, rowH:rows[0]?Math.round(rows[0].getBoundingClientRect().height):null, card:!!card, products:document.querySelectorAll('.shop-card .worklist__row').length, cardRowsScroll:(e=>e?e.scrollHeight-e.clientHeight:null)(document.querySelector('.shop-card__rows')), pageScroll:document.documentElement.scrollHeight-innerHeight, listBottom:wl?Math.round(wl.getBoundingClientRect().bottom):null, pager:document.querySelector('.pagination-sticky, [class*=pagination]')?.textContent.slice(0,40)||null, small:[...document.querySelectorAll('.shop-order *, .shop-card *')].filter(e=>e.children.length===0&&e.textContent.trim()&&parseFloat(getComputedStyle(e).fontSize)<13).length};})()`);
export default async function (b) {
  const out = {};
  for (const [w, h] of [[1440, 900], [1280, 800]]) {
    await b.viewport(w, h);
    await b.goto('http://localhost:5173/production/kanban?design=1'); await b.waitFor('.shop-order'); await b.wait(1500);
    out[`list${w}`] = await m(b); await b.shot(`shop-list-${w}.png`);
    const r = await b.rect('.shop-order:not(.shop-order--head)', 0); await b.click(r.cx, r.cy); await b.wait(700);
    out[`card${w}`] = await m(b); await b.shot(`shop-card-${w}.png`);
    const back = await b.rect('.shop-card__head button', 0); await b.click(back.cx, back.cy); await b.wait(500);
    out[`back${w}`] = await m(b);
  }
  await b.viewport(1440, 900);
  await b.goto('http://localhost:5173/orders?design=1'); await b.waitFor('.topnav__item'); await b.wait(1800);
  out.orders = await b.eval(`({tabs:[...document.querySelectorAll('[role=tab], .mantine-Tabs-tab, .seg-tab')].map(e=>e.textContent.trim()).slice(0,4), table:!!document.querySelector('table'), digest:!!document.querySelector('[class*=digest]'), pageScroll:document.documentElement.scrollHeight-innerHeight})`);
  await b.shot('orders-default.png');
  return out;
}
