#!/usr/bin/env node
/**
 * Измеритель интерфейса на голом CDP (05.09.2026).
 *
 * Зачем: встроенная панель браузера в редакторе часто скрыта, а в
 * скрытой вкладке Chrome троттлит таймеры до 1 с (после 5 минут — до
 * минуты). Любая проверка всплывашек с задержкой 200 мс там врёт.
 * Headless-Chrome с CDP таймеры не троттлит, а мышь и клавиатура —
 * настоящие (Input.dispatchMouseEvent), не синтетические события.
 *
 * Использование:
 *   node scripts/cdp-probe.mjs <сценарий.mjs> [каталог-для-снимков]
 * Сценарий экспортирует по умолчанию async-функцию (b) => результат;
 * результат печатается как JSON. Библиотек не нужно: Node ≥ 22 даёт
 * глобальный WebSocket.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , scriptPath, outDir = '.'] = process.argv;
if (!scriptPath) { console.error('нужен путь к сценарию'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
// Профиль одноразовый: иначе localStorage (открытые секции, режимы) утекает между прогонами
rmSync(`${outDir}/.chrome-profile`, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', `--user-data-dir=${outDir}/.chrome-profile`, '--window-size=1440,900', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const wsUrl = await new Promise((res, rej) => {
  let buf = '';
  chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
  chrome.on('exit', (c) => rej(new Error('chrome вышел: ' + c)));
  setTimeout(() => rej(new Error('нет адреса DevTools: ' + buf.slice(-300))), 15000);
});

class CDP {
  constructor(ws) { this.ws = ws; this.n = 0; this.pending = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = m.id && this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }; }
  send(method, params = {}, sessionId) { return new Promise((res, rej) => { const id = ++this.n; this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params, sessionId })); }); }
}
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const cdp = new CDP(ws);
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
const s = (m, p) => cdp.send(m, p, sessionId);
await s('Page.enable'); await s('Runtime.enable');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b = {
  out: outDir,
  wait,
  async viewport(width, height) { await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); },
  async goto(url) { await s('Page.navigate', { url }); await wait(400); },
  async eval(expression) {
    const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  },
  async waitFor(sel, timeout = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (await b.eval(`!!document.querySelector(${JSON.stringify(sel)})`)) return; await wait(150); }
    throw new Error('не дождался ' + sel);
  },
  /** Прямоугольник i-го элемента по селектору (центр — cx, cy) */
  async rect(sel, i = 0) {
    return b.eval(`(()=>{const e=document.querySelectorAll(${JSON.stringify(sel)})[${i}]; if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2};})()`);
  },
  async move(x, y) { await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); },
  async click(x, y) {
    await b.move(x, y);
    await s('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  },
  async key(key, code = key, windowsVirtualKeyCode) {
    await s('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode });
    await s('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
  },
  async shot(name) { const { data } = await s('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${outDir}/${name}`, Buffer.from(data, 'base64')); },
};

try {
  const mod = await import(pathToFileURL(scriptPath).href);
  const result = await mod.default(b);
  console.log(JSON.stringify(result, null, 1));
} catch (e) {
  console.error('ОШИБКА:', e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
}
