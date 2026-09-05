/** Изделия: таблица → карточка → назад, два размера */
const m = (b) => b.eval(`(()=>{const rows=document.querySelectorAll('.specs-table tbody tr'); const card=document.querySelector('.specs-card'); const body=document.querySelector('.specs-card__body'); return {viewport:[innerWidth,innerHeight], rows:rows.length, rowH:rows[0]?Math.round(rows[0].getBoundingClientRect().height):null, card:!!card, stages:document.querySelectorAll('.specs-card .stage-cell').length, facts:document.querySelectorAll('.specs-card .fact').length, normsScroll:(e=>e?e.scrollHeight-e.clientHeight:null)(document.querySelector('.specs-card__norms')), costScroll:(e=>e?e.scrollHeight-e.clientHeight:null)(document.querySelector('.specs-card__cost')), pageScroll:document.documentElement.scrollHeight-innerHeight, tableOverflow:(e=>e?e.scrollWidth-e.clientWidth:null)(document.querySelector('.specs-table-wrap')), url:location.search};})()`);
export default async function (b) {
  const out = {};
  for (const [w, h] of [[1440, 900], [1280, 800]]) {
    await b.viewport(w, h);
    await b.goto('http://localhost:5173/specs?design=1'); await b.waitFor('.specs-table tbody tr'); await b.wait(1500);
    out[`list${w}`] = await m(b); await b.shot(`specs-list-${w}.png`);
    const r = await b.rect('.specs-table tbody tr', 0); await b.click(r.cx, r.cy); await b.wait(1200);
    out[`card${w}`] = await m(b); await b.shot(`specs-card-${w}.png`);
    out[`save${w}`] = await b.eval(`[...document.querySelectorAll(".specs-card .stage-cell")].map(c=>{const btn=[...c.querySelectorAll("button")].find(x=>x.textContent.trim()==="Сохранить"); const fact=c.querySelector(".stage-cell__fact"); const cr=c.getBoundingClientRect(); return {saveInside:btn?Math.round(cr.right-btn.getBoundingClientRect().right):null, factInside:fact?Math.round(cr.right-fact.getBoundingClientRect().right):null, cellH:Math.round(cr.height)}})`);
    const fact = await b.rect('.specs-card .fact', 0); await b.click(fact.cx, fact.cy); await b.wait(900);
    out[`bom${w}`] = await b.eval(`({detail:!!document.querySelector('.specs-detail'), rows:document.querySelectorAll('.specs-detail .bom-row, .specs-detail tr').length, costScroll:(e=>e.scrollHeight-e.clientHeight)(document.querySelector('.specs-card__cost')), pageScroll:document.documentElement.scrollHeight-innerHeight})`);
    await b.shot(`specs-bom-${w}.png`);
    const back = await b.rect('.specs-card__head button', 0); await b.click(back.cx, back.cy); await b.wait(600);
    out[`back${w}`] = await m(b);
  }
  return out;
}
