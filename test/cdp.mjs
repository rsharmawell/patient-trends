// Minimal Chrome DevTools Protocol driver. No npm dependencies: it uses
// Node 22's built-in global WebSocket.
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9222;
const userDir = mkdtempSync(join(tmpdir(), 'cdp-'));

export async function launch() {
  const CHROME =
    process.env.CHROME ||
    ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
     '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
     '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
  if (!CHROME) throw new Error('No Chrome/Chromium found. Set CHROME=/path/to/chrome');

  const proc = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDir}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let ver = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      ver = await r.json();
      break;
    } catch (_) { await new Promise((r) => setTimeout(r, 250)); }
  }
  if (!ver) { proc.kill(); throw new Error('chromium did not expose CDP'); }

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const events = [];
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id != null) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
      else p.res(msg.result);
    } else {
      events.push(msg);
      for (const l of listeners) l(msg);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');

  return {
    send, events, proc, ws,
    on: (fn) => listeners.push(fn),
    /** Fire-and-forget navigation, for pages that immediately redirect away. */
    async navigate(url) {
      await send('Page.navigate', { url });
    },
    async goto(url) {
      await send('Page.navigate', { url });
      // Poll rather than trust a single load event — stale events from a prior
      // navigation would otherwise resolve this immediately.
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 150));
        try {
          const ok = await this.eval(
            `location.href.split('#')[0] === ${JSON.stringify(url)} && document.readyState === 'complete'`
          );
          if (ok) { await new Promise((r) => setTimeout(r, 250)); return; }
        } catch (_) { /* context swapping mid-navigation */ }
      }
      throw new Error('navigation to ' + url + ' did not settle');
    },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('page eval threw: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
      return r.result.value;
    },
    async url() { return this.eval('location.href'); },
    async shot(path) {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, Buffer.from(r.data, 'base64'));
    },
    close() { try { ws.close(); } catch (_) {} proc.kill(); },
  };
}
