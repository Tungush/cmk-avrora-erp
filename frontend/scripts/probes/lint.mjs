/** Линт вёрстки по всем состояниям: обрезанные элементы, рваные строки таблиц, мусор в тексте + обход таблиц */
import { STATES, MEASURE } from './tables.mjs';

const LINT = `(()=>{
  const vis=e=>{if(!e) return false; const r=e.getBoundingClientRect(); return r.width>0&&r.height>0;};
  const out={clipped:[], rows:[], text:[]};
  const cand=[...document.querySelectorAll('.mantine-Badge-root, .mantine-Button-root, .mantine-ActionIcon-root, .worklist__chip, .stat__value, .stat__label, .peek__inline, .mantine-Text-root, td > span, td > div')].filter(vis);
  for (const el of cand){
    if (getComputedStyle(el).webkitLineClamp && getComputedStyle(el).webkitLineClamp!=='none') continue;
    const r=el.getBoundingClientRect(); let a=el.parentElement;
    while(a && a!==document.body){ const cs=getComputedStyle(a); if(/hidden|auto|scroll|clip/.test(cs.overflowX+' '+cs.overflowY)){ const ar=a.getBoundingClientRect(); const cut=Math.max(0, ar.left-r.left, r.right-ar.right, ar.top-r.top, r.bottom-ar.bottom); if(cut>2 && !(cs.overflowX==='auto'||cs.overflowX==='scroll'||cs.overflowY==='auto'||cs.overflowY==='scroll')){ out.clipped.push({text:(el.textContent||el.getAttribute('aria-label')||'').trim().slice(0,26), cut:Math.round(cut), by:(a.className||a.tagName).toString().split(' ')[0].slice(0,26)}); } break; } a=a.parentElement; }
    if (out.clipped.length>=10) break; }
  for (const t of [...document.querySelectorAll('table')].filter(vis)){ const hs=[...t.querySelectorAll('tbody tr')].filter(vis).map(tr=>Math.round(tr.getBoundingClientRect().height)); if(hs.length>2){ const mn=Math.min(...hs), mx=Math.max(...hs); if(mx>mn*1.5) out.rows.push({heads:[...t.querySelectorAll('th')].slice(0,4).map(x=>x.textContent.trim()).join('|').slice(0,44), min:mn, max:mx, n:hs.length}); } }
  const bad=/₸\\s*₸|undefined|NaN|\\[object/; const w=document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while(w.nextNode()){ const n=w.currentNode; const t=n.textContent; if(t.trim().length<2) continue; if(bad.test(t) && vis(n.parentElement)) { out.text.push(t.trim().replace(/\\s+/g,' ').slice(0,40)); if(out.text.length>=8) break; } }
  return out;
})()`;

export default async function (b) {
  const out = {};
  await b.viewport(1280, 800);
  for (const [name, path, actions] of STATES) {
    try {
      const url = 'http://localhost:5173' + path + (path.includes('?') ? '&' : '?') + 'design=1';
      await b.goto(url); await b.waitFor('.topnav__item'); await b.wait(1600);
      const found = [];
      const check = async (state) => { const t = await b.eval(MEASURE); const l = await b.eval(LINT); if (t.problems.length || l.clipped.length || l.rows.length || l.text.length) found.push({ state, tables: t.problems, ...l }); };
      await check('base');
      for (const act of actions) {
        if (act.startsWith('ROW:')) { const r = await b.rect(act.slice(4), 0); if (!r) continue; await b.click(r.cx, r.cy); await b.wait(1400); await check('card'); }
        else { const n = await b.eval(`document.querySelectorAll(${JSON.stringify(act)}).length`); for (let i = 0; i < Math.min(n, 7); i++) { const r = await b.rect(act, i); if (!r || r.w === 0) continue; await b.click(r.cx, r.cy); await b.wait(900); await check(`${act.slice(0, 12)}#${i}`); } }
      }
      out[name] = found.length ? found : 'чисто';
    } catch (e) { out[name] = 'ОШИБКА ' + e.message.slice(0, 80); }
  }
  return out;
}
