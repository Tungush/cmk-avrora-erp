/** Сценарий проверки экрана директора: раскладка, peek, вкладки, два размера экрана */
const measure = (b) => b.eval(`(()=>{
  const fs=document.querySelector('.fit-screen'), dd2=document.querySelector('.dd2'), ring=document.querySelector('.ringdash__disc'), rings=document.querySelector('.dd2__rings'), s=document.querySelector('.stat'), panel=document.querySelector('.panel'), body=document.querySelector('.panel__body'), tabs=document.querySelector('.panel__tabs');
  return {viewport:[innerWidth,innerHeight], pageScroll:document.documentElement.scrollHeight-innerHeight,
    fitTop:Math.round(fs.getBoundingClientRect().top), fitH:Math.round(fs.getBoundingClientRect().height),
    dd2Bottom:Math.round(dd2.getBoundingClientRect().bottom), ringsBottom:Math.round(rings.getBoundingClientRect().bottom), ringsOverflow:rings.scrollHeight-rings.clientHeight,
    ringSize:Math.round(ring.getBoundingClientRect().width), statH:Math.round(s.getBoundingClientRect().height), statValue:getComputedStyle(s.querySelector('.stat__value')).fontSize,
    panelBottom:Math.round(panel.getBoundingClientRect().bottom), tabsOverflow:tabs.scrollWidth-tabs.clientWidth, tabsCount:document.querySelectorAll('.panel__tab').length,
    activeTab:document.querySelector('.panel__tab[aria-selected="true"]')?.textContent, bodyScroll:body.scrollHeight-body.clientHeight, bodyH:Math.round(body.clientHeight)};})()`);

export default async function (b) {
  const out = {};
  await b.viewport(1440, 900);
  await b.goto('http://localhost:5173/dashboard/director?design=1');
  await b.waitFor('.ringdash__legend'); await b.wait(1600);
  out.layout1440 = await measure(b);

  const card = await b.rect('.stat-row .peek__target', 1);
  await b.move(card.cx, card.cy); await b.wait(450);
  out.hoverPeek = await b.eval(`(()=>{const d=document.querySelector('.peek--hover'); if(!d) return null; const r=d.getBoundingClientRect(); return {y:Math.round(r.y), h:Math.round(r.height), rows:d.querySelectorAll('.peek__row').length, hint:!!d.querySelector('.peek__hint')};})()`);
  await b.move(900, 100); await b.wait(450);
  out.hoverGone = await b.eval(`!document.querySelector('.peek--hover')`);

  const cell = await b.rect('.dense .peek__target', 0);
  await b.click(cell.cx, cell.cy); await b.wait(500);
  out.pinned = await b.eval(`(()=>{const d=document.querySelector('.peek--pinned'); const t=document.querySelector('.dense .peek__target'); return {present:!!d, y:d?Math.round(d.getBoundingClientRect().y):null, cellY:Math.round(t.getBoundingClientRect().y), actions:[...document.querySelectorAll('.peek--pinned .peek__actions button')].map(b=>b.textContent), focusInside:!!document.activeElement.closest('.peek--pinned')};})()`);
  await b.shot('probe-pinned.png');
  await b.key('Escape', 'Escape', 27); await b.wait(500);
  out.afterEsc = await b.eval(`({pinnedGone:!document.querySelector('.peek--pinned'), activeIsCell:document.activeElement===document.querySelector('.dense .peek__target')})`);
  await b.move(900, 100); await b.wait(400);

  await b.eval(`document.querySelectorAll('.dense .peek__target')[1].focus()`); await b.wait(450);
  out.focusPeek = await b.eval(`!!document.querySelector('.peek--hover')`);
  await b.eval(`document.activeElement.blur()`); await b.wait(450);
  out.focusPeekGone = await b.eval(`!document.querySelector('.peek--hover')`);

  // карточка «Долг поставщикам» → вкладка «Деньги»; кольцо → та же связка; строка легенды → центр
  const stat = await b.rect('.stat-row .peek__target', 1); await b.click(stat.cx, stat.cy); await b.wait(400);
  out.statSelect = await b.eval(`({tab:document.querySelector('.panel__tab[aria-selected="true"]')?.textContent.slice(0,12), activeStat:document.querySelector('.stat[data-active]')?.dataset.hue||null})`);
  const row = await b.rect('.ringdash__row', 0); await b.move(row.cx, row.cy); await b.wait(250);
  out.ringPeekCenter = await b.eval(`document.querySelector('.ringdash__center-value').textContent+' / '+document.querySelector('.ringdash__center-label').textContent`);
  await b.click(row.cx, row.cy); await b.wait(400);
  out.ringSelect = await b.eval(`({tab:document.querySelector('.panel__tab[aria-selected="true"]')?.textContent.slice(0,12), activeStat:document.querySelector('.stat[data-active]')?.dataset.hue||null})`);
  await b.move(900, 100); await b.wait(400);
  out.restCenter = await b.eval(`document.querySelector('.ringdash__center-value').textContent+' / '+document.querySelector('.ringdash__center-label').textContent`);
  for (const i of [1, 2, 0]) { const t = await b.rect('.panel__tab', i); await b.click(t.cx, t.cy); await b.wait(350); out['tab' + i] = await b.eval(`({tab:document.querySelector('.panel__tab[aria-selected="true"]')?.textContent.slice(0,10), rows:document.querySelectorAll('.panel__body tr, .panel__body .dd-decision, .panel__body .peek__row').length, bodyScroll:(b=>b.scrollHeight-b.clientHeight)(document.querySelector('.panel__body'))})`); }
  await b.shot('probe-1440.png');

  await b.viewport(1280, 800); await b.wait(900);
  out.layout1280 = await measure(b);
  await b.shot('probe-1280.png');
  return out;
}
