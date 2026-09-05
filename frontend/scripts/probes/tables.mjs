/** Обход всех таблиц сервиса: переполнение контейнера, сдвиг влево, обрезанный многоточием текст */
const MEASURE = `(()=>{
  const vis=e=>{const r=e.getBoundingClientRect(); return r.width>0&&r.height>0;};
  const out=[]; const tables=[...document.querySelectorAll('table')].filter(vis);
  for (const t of tables){
    const c=t.parentElement; const tr=t.getBoundingClientRect(), cr=c.getBoundingClientRect();
    const overflow=Math.round(tr.width-c.clientWidth); const leftClip=Math.round(tr.left-cr.left); const scrollable=/auto|scroll/.test(getComputedStyle(c).overflowX);
    const cells=[...t.querySelectorAll('td, th, .mantine-Badge-label, .mantine-Text-root')].filter(e=>{const cs=getComputedStyle(e); return cs.textOverflow==='ellipsis'&&cs.overflow!=='visible'&&e.scrollWidth>e.clientWidth+1&&vis(e);});
    const heads=[...t.querySelectorAll('th')].slice(0,7).map(th=>th.textContent.trim()).join(' | ');
    const card=t.closest('[id^=card-], .mantine-Card-root, .panel__body, section');
    const where=card?(card.id||card.className.toString().split(' ')[0]):'';
    if ((overflow>2)||leftClip<-1||cells.length>0) out.push({scroll:scrollable, heads:heads.slice(0,90), where:where.slice(0,30), tableW:Math.round(tr.width), containerW:c.clientWidth, overflow, leftClip, truncated:cells.length, samples:cells.slice(0,3).map(e=>e.textContent.trim().slice(0,28))});
  }
  return {tables:tables.length, problems:out};
})()`;

const STATES = [
  ['director', '/dashboard/director', ['.panel__tab']],
  ['orders', '/orders?tab=registry', []],
  ['orders-card', '/orders?tab=registry', ['ROW:.mantine-Table-tbody tr']],
  ['orders-dash', '/orders?tab=dashboard', []],
  ['inbox', '/orders/inbox', []],
  ['production', '/production', ['[role=tab]']],
  ['kanban-card', '/production/kanban', ['ROW:.shop-order:not(.shop-order--head)']],
  ['contractors-requests', '/production/contractors?tab=requests', []],
  ['contractors-allocated', '/production/contractors?tab=allocated', []],
  ['pipeline', '/sales/pipeline', []],
  ['warehouse-stock', '/warehouse?tab=stock', []],
  ['warehouse-storeroom', '/warehouse?tab=storeroom', []],
  ['warehouse-fg', '/warehouse?tab=fg', []],
  ['warehouse-batches', '/warehouse?tab=batches', []],
  ['warehouse-minstock', '/warehouse?tab=minstock', []],
  ['warehouse-offcuts', '/warehouse?tab=offcuts', []],
  ['purchases-dashboard', '/purchases?tab=dashboard', []],
  ['purchases-registry', '/purchases?tab=registry', []],
  ['purchases-queue', '/purchases?tab=queue', []],
  ['prices', '/prices', ['[role=tab]']],
  ['finance-orders', '/finance?tab=orders', []],
  ['finance-receivables', '/finance?tab=receivables', ['.mantine-SegmentedControl-label, .view-switch button']],
  ['finance-reconciliation', '/finance?tab=reconciliation', []],
  ['finance-documents', '/finance?tab=documents', []],
  ['finance-damu', '/finance?tab=damu', []],
  ['specs-card', '/specs', ['ROW:.specs-table tbody tr', '.fact']],
  ['sites', '/sites', []],
  ['settings', '/settings', ['[role=tab]']],
  ['integration', '/integration', []],
];

export default async function (b) {
  const out = {};
  await b.viewport(1280, 800);
  for (const [name, path, actions] of STATES) {
    try {
      const url = 'http://localhost:5173' + path + (path.includes('?') ? '&' : '?') + 'design=1';
      await b.goto(url); await b.waitFor('.topnav__item'); await b.wait(1600);
      const found = [];
      const base = await b.eval(MEASURE); if (base.problems.length) found.push({ state: 'base', ...base });
      for (const act of actions) {
        if (act.startsWith('ROW:')) {
          const r = await b.rect(act.slice(4), 0); if (!r) continue; await b.click(r.cx, r.cy); await b.wait(1400);
          const m = await b.eval(MEASURE); if (m.problems.length) found.push({ state: 'card', ...m });
          await b.shot(`tables-${name}.png`);
        } else {
          const n = await b.eval(`document.querySelectorAll(${JSON.stringify(act)}).length`);
          for (let i = 0; i < Math.min(n, 7); i++) {
            const r = await b.rect(act, i); if (!r || r.w === 0) continue; await b.click(r.cx, r.cy); await b.wait(900);
            const m = await b.eval(MEASURE); if (m.problems.length) found.push({ state: `${act}#${i}`, ...m });
          }
        }
      }
      out[name] = found.length ? found : 'чисто';
    } catch (e) { out[name] = 'ОШИБКА ' + e.message.slice(0, 80); }
  }
  return out;
}
