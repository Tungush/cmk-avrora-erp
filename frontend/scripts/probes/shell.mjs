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

/** Скрытая шапка: переключение через меню аккаунта, выезд по верхнему краю */
export async function grip(b) {
  await b.viewport(1440, 900);
  await b.goto("http://localhost:5173/dashboard/director?design=1"); await b.waitFor(".topnav__item"); await b.wait(1200);
  const m = () => b.eval(`({header:Math.round(document.querySelector(".mantine-AppShell-header").getBoundingClientRect().height), fitTop:Math.round(document.querySelector(".fit-screen").getBoundingClientRect().top), navVisible:[...document.querySelectorAll(".topnav__item")].filter(e=>e.getBoundingClientRect().height>0).length, chrome:document.documentElement.dataset.chrome, pageScroll:document.documentElement.scrollHeight-innerHeight})`);
  const toggle = async () => { const acc = await b.rect("button[aria-label=\"Аккаунт\"]"); await b.click(acc.cx, acc.cy); await b.wait(400); const item = await b.eval(`(()=>{const el=[...document.querySelectorAll(".mantine-Menu-item")].find(e=>/меню/.test(e.textContent)); if(!el) return null; const r=el.getBoundingClientRect(); return {cx:r.x+r.width/2, cy:r.y+r.height/2, text:el.textContent};})()`); if (!item) throw new Error("нет пункта меню"); await b.click(item.cx, item.cy); await b.wait(500); return item.text; };
  const before = await m();
  const t1 = await toggle(); await b.move(700, 500); await b.wait(500); const hidden = await m(); await b.shot("chrome-hidden.png");
  await b.move(700, 4); await b.wait(500); const peek = await m(); await b.shot("chrome-peek.png");
  await b.move(700, 500); await b.wait(500); const gone = await m();
  await b.move(700, 4); await b.wait(400); const t2 = await toggle(); await b.move(700, 500); await b.wait(400); const back = await m();
  return { before, t1, hidden, peek, gone, t2, back };
}
