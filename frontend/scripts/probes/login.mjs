export default async function (b) {
  const out = {};
  for (const [w, h] of [[1440, 900], [1280, 800]]) {
    await b.viewport(w, h);
    await b.goto('http://localhost:5173/login?design=1'); await b.waitFor('.login-card'); await b.wait(1200);
    out[`login${w}`] = await b.eval(`(()=>{const c=document.querySelector('.login-card').getBoundingClientRect(); const t=document.querySelector('.login-brand__title'); return {pageScroll:document.documentElement.scrollHeight-innerHeight, card:[Math.round(c.x),Math.round(c.y),Math.round(c.width),Math.round(c.height)], titleSize:getComputedStyle(t).fontSize, inputs:document.querySelectorAll('input').length, small:[...document.querySelectorAll('.login-scene *')].filter(e=>e.children.length===0&&e.textContent.trim()&&parseFloat(getComputedStyle(e).fontSize)<13).length};})()`);
    await b.shot(`login-${w}.png`);
  }
  return out;
}
