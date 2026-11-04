// 打开 URL → 如遇 ngrok 拦截页点击 Visit Site → 等待 → 执行表达式 → 截图
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
const [,, url, expr, shot] = process.argv;
const port = 9344;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new','--disable-gpu',`--remote-debugging-port=${port}`,'--user-data-dir=/tmp/sf-click-profile','--window-size=1280,800','about:blank'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1500));
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const send = (method, params) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
await new Promise(r => ws.on('open', r));
await send('Page.enable');
await send('Page.navigate', { url });
await new Promise(r => setTimeout(r, 4000));
// 尝试点击 Visit Site
const clicked = await send('Runtime.evaluate', { expression: `(function(){ const els=[...document.querySelectorAll('a,button')]; const b=els.find(e=>/visit site/i.test(e.textContent)); if(b){b.click(); return b.textContent.trim();} return null; })()`, returnByValue: true });
await new Promise(r => setTimeout(r, 5000));
const res = await send('Runtime.evaluate', { expression: expr ?? 'document.title', returnByValue: true });
console.log('clicked:', JSON.stringify(clicked.result?.value), '=>', JSON.stringify(res.result?.value ?? res.result?.description));
if (shot) { const s = await send('Page.captureScreenshot', { format: 'png' }); (await import('node:fs')).writeFileSync(shot, Buffer.from(s.data, 'base64')); }
chrome.kill(); process.exit(0);
