/** Оболочка: шапка с разделами на трёх ширинах и на разных экранах */
const nav = (b) => b.eval(`(()=>{const n=document.querySelector('.topnav'); const items=[...document.querySelectorAll('.topnav__item')]; const h=document.querySelector('.mantine-AppShell-header'); const tools=document.querySelector('.topbar__tools');
  return {viewport:[innerWidth,innerHeight], items:items.length, labelsVisible:items.filter(i=>{const l=i.querySelector('.topnav__label'); return l&&getComputedStyle(l).display!=='none'}).length,
    navOverflow:n.scrollWidth-n.clientWidth, navRight:Math.round(n.getBoundingClientRect().right), itemsRight:Math.round(Math.max(...items.map(i=>i.getBoundingClientRect().right))), toolsLeft:Math.round(tools.getBoundingClientRect().left),
    active:document.querySelector('.topnav__item[data-active]')?.textContent||null, headerH:Math.round(h.getBoundingClientRect().height), botnav:!!document.querySelector('.botnav'),
    pageScroll:document.documentElement.scrollHeight-innerHeight, shellBottom:getComputedStyle(document.documentElement).getPropertyValue('--shell-bottom').trim()};})()`);
export default async function (b) {
  const out = {};
  for (const [w, h] of [[1440, 900], [1280, 800], [1180, 800]]) {
    await b.viewport(w, h);
    await b.goto('http://localhost:5173/orders?design=1'); await b.waitFor('.topnav__item'); await b.wait(1200);
    out[`orders_${w}`] = await nav(b);
    await b.shot(`shell-orders-${w}.png`);
  }
  await b.viewport(1440, 900);
  for (const [name, path] of [['work', '/'], ['kanban', '/production/kanban'], ['purchases', '/purchases']]) {
    await b.goto(`http://localhost:5173${path}?design=1`); await b.waitFor('.topnav__item'); await b.wait(1500);
    out[name] = await nav(b);
    await b.shot(`shell-${name}.png`);
  }
  return out;
}
