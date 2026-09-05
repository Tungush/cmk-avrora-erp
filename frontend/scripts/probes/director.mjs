/** Сценарий проверки экрана директора: раскладка, peek, фокус-режим, два размера экрана */
const measure = (b) => b.eval(`(()=>{
  const heads=[...document.querySelectorAll('.section__head')].map(e=>Math.round(e.getBoundingClientRect().bottom));
  const nav=document.querySelector('[class*=botnav]'); const navTop=nav?Math.round(nav.getBoundingClientRect().top):null;
  const fs=document.querySelector('.fit-screen'), dd2=document.querySelector('.dd2'), ring=document.querySelector('.ringdash__disc'), rings=document.querySelector('.dd2__rings'), s=document.querySelector('.stat');
  return {viewport:[innerWidth,innerHeight], pageScroll:document.documentElement.scrollHeight-innerHeight,
    shellBottom:getComputedStyle(document.documentElement).getPropertyValue('--shell-bottom').trim(), botnav:document.documentElement.dataset.botnav||'full',
    fitTop:Math.round(fs.getBoundingClientRect().top), fitH:Math.round(fs.getBoundingClientRect().height),
    dd2Bottom:Math.round(dd2.getBoundingClientRect().bottom), ringsBottom:Math.round(rings.getBoundingClientRect().bottom), ringsOverflow:rings.scrollHeight-rings.clientHeight,
    ringSize:Math.round(ring.getBoundingClientRect().width), statH:Math.round(s.getBoundingClientRect().height), statValue:getComputedStyle(s.querySelector('.stat__value')).fontSize,
    headsBottom:heads, navTop, allHeadsAboveNav:navTop==null||heads.every(h=>h<=navTop)};})()`);

export default async function (b) {
  const out = {};
  await b.viewport(1440, 900);
  await b.goto('http://localhost:5173/dashboard/director?design=1');
  await b.waitFor('.ringdash__legend'); await b.wait(1600);
  out.layout1440 = await measure(b);

  const card = await b.rect('.stat-row .peek__target', 1);
  await b.move(card.cx, card.cy); await b.wait(450);
  out.hoverPeek = await b.eval(`(()=>{const d=document.querySelector('.peek--hover'); if(!d) return null; const r=d.getBoundingClientRect(); return {y:Math.round(r.y), h:Math.round(r.height), rows:d.querySelectorAll('.peek__row').length, hint:!!d.querySelector('.peek__hint')};})()`);
  await b.shot('probe-hover.png');
  await b.move(900, 100); await b.wait(450);
  out.hoverGone = await b.eval(`!document.querySelector('.peek--hover')`);

  const tg = await b.rect('.section[data-section="margin"] .section__toggle');
  await b.click(tg.cx, tg.cy); await b.wait(500);
  const cell = await b.rect('.dense .peek__target', 0);
  await b.click(cell.cx, cell.cy); await b.wait(500);
  out.pinned = await b.eval(`(()=>{const d=document.querySelector('.peek--pinned'); const t=document.querySelector('.dense .peek__target'); return {present:!!d, dataPinned:t.dataset.pinned||null, y:d?Math.round(d.getBoundingClientRect().y):null, cellY:Math.round(t.getBoundingClientRect().y), actions:[...document.querySelectorAll('.peek--pinned .peek__actions button')].map(b=>b.textContent), focusInside:!!document.activeElement.closest('.peek--pinned'), hoverAlso:!!document.querySelector('.peek--hover')};})()`);
  await b.shot('probe-pinned.png');
  await b.key('Escape', 'Escape', 27); await b.wait(500);
  out.afterEsc = await b.eval(`({pinnedGone:!document.querySelector('.peek--pinned'), activeIsCell:document.activeElement===document.querySelector('.dense .peek__target')})`);
  await b.move(900, 100); await b.wait(400);

  await b.eval(`document.querySelectorAll('.dense .peek__target')[1].focus()`); await b.wait(450);
  out.focusPeek = await b.eval(`!!document.querySelector('.peek--hover')`);
  await b.eval(`document.activeElement.blur()`); await b.wait(450);
  out.focusPeekGone = await b.eval(`!document.querySelector('.peek--hover')`);

  const fb = await b.rect('.section[data-section="margin"] .section__focus');
  await b.click(fb.cx, fb.cy); await b.wait(500);
  out.focusMode = await b.eval(`(()=>{const f=document.querySelector('.section[data-focused]'); const body=f?.querySelector('.section__body'); return {focused:f?.dataset.section||null, dimmed:document.querySelectorAll('.section[data-dimmed]').length, dimmedBodiesVisible:[...document.querySelectorAll('.section[data-dimmed] .section__body')].filter(e=>e.getBoundingClientRect().height>0).length, bodyH:body?Math.round(body.clientHeight):0, bodyScroll:body?body.scrollHeight-body.clientHeight:0, pageScroll:document.documentElement.scrollHeight-innerHeight};})()`);
  await b.shot('probe-focus.png');
  await b.key('Escape', 'Escape', 27); await b.wait(400);
  out.focusExit = await b.eval(`document.querySelector('.section[data-focused]')?.dataset.section||null`);

  const row = await b.rect('.ringdash__row', 1);
  await b.move(row.cx, row.cy); await b.wait(250);
  out.ringPeekCenter = await b.eval(`document.querySelector('.ringdash__center-value').textContent+' / '+document.querySelector('.ringdash__center-label').textContent`);
  await b.click(row.cx, row.cy); await b.wait(500);
  out.ringSelect = await b.eval(`({focused:document.querySelector('.section[data-focused]')?.dataset.section||null, activeStat:document.querySelector('.stat[data-active]')?.dataset.hue||null})`);
  await b.key('Escape', 'Escape', 27); await b.move(900, 100); await b.wait(400);
  out.restCenter = await b.eval(`document.querySelector('.ringdash__center-value').textContent+' / '+document.querySelector('.ringdash__center-label').textContent`);
  await b.shot('probe-1440.png');

  await b.viewport(1280, 800); await b.wait(900);
  out.layout1280 = await measure(b);
  await b.shot('probe-1280.png');
  return out;
}
