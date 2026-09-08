/** Контраст текста на реальной странице: цвет текста против фона, собранного по предкам с учётом альфы */
const PROBE = `(()=>{
  const lum=(r,g,b)=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b)};
  const ratio=(a,b)=>{const l1=lum(...a),l2=lum(...b);return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05)};
  const parse=s=>{const m=s.match(/rgba?\\(([^)]+)\\)/); if(!m) return null; const p=m[1].split(',').map(Number); return [p[0],p[1],p[2],p.length>3?p[3]:1]};
  const over=(top,bottom)=>{const a=top[3]; return [top[0]*a+bottom[0]*(1-a), top[1]*a+bottom[1]*(1-a), top[2]*a+bottom[2]*(1-a), 1]};
  const bgOf=el=>{ let acc=null; for(let e=el;e;e=e.parentElement){ const c=parse(getComputedStyle(e).backgroundColor); if(c&&c[3]>0){ acc=acc?over(acc,c):c; if(acc[3]>=0.999) return acc; } } const root=parse(getComputedStyle(document.documentElement).backgroundColor); const base=root&&root[3]>0?root:[238,241,245,1]; return acc?over(acc,base):base; };
  const bad=[]; let checked=0;
  const walker=document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while(walker.nextNode()){ const n=walker.currentNode; const t=n.textContent.trim(); if(t.length<2) continue; const el=n.parentElement; if(!el) continue;
    const cs=getComputedStyle(el); if(cs.visibility==='hidden'||cs.display==='none') continue; const r=el.getBoundingClientRect(); if(r.width===0||r.height===0||r.bottom<0||r.top>innerHeight) continue;
    const fg=parse(cs.color); if(!fg) continue; const fgc=fg[3]<1?over(fg,bgOf(el)):fg; const bg=bgOf(el); const rr=ratio(fgc,bg); checked++;
    const size=parseFloat(cs.fontSize), bold=parseInt(cs.fontWeight)>=700; const large=size>=24||(size>=18.66&&bold); const need=large?3:4.5;
    if(rr<need) bad.push({text:t.slice(0,28), ratio:+rr.toFixed(2), size, sel:(el.className&&typeof el.className==='string'?'.'+el.className.split(' ')[0]:el.tagName.toLowerCase())}); }
  bad.sort((a,b)=>a.ratio-b.ratio); return {checked, bad:bad.slice(0,12), badCount:bad.length};
})()`;
export default async function (b) {
  const out = {};
  await b.viewport(1440, 900);
  for (const [name, path] of [['director', '/dashboard/director'], ['work', '/'], ['orders', '/orders'], ['kanban', '/production/kanban'], ['purchases', '/purchases'], ['sites', '/sites'], ['warehouse', '/warehouse'], ['finance', '/finance']]) {
    await b.goto(`http://localhost:5173${path}?design=1`); await b.waitFor('.rail__item'); await b.wait(1800);
    out[name] = await b.eval(PROBE);
    await b.shot(`light-${name}.png`);
  }
  return out;
}
