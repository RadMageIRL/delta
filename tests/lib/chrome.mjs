// Headless Chrome over the DevTools protocol, with no dependencies (Node 22+ for the global
// WebSocket). Set CHROME_PATH to use a particular Chrome or Edge.
//
// Two things every test relies on:
// - Site isolation is off, so the sandboxed preview frames stay in the page's process and can be
//   inspected through Page.getFrameTree.
// - Every request is paused by Fetch interception. One to the page's own origin (or a file:,
//   data: or blob: URL) continues; one to anywhere else is recorded in `outside` and failed, so
//   no test ever reaches another site, and a leak shows up as a recorded URL.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const local = process.env.LOCALAPPDATA || '';
  for (const c of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    join(local, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]) if (c && existsSync(c)) return c;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  throw new Error('No Chrome or Edge found. Set CHROME_PATH.');
}

export async function launch({ width = 1400, height = 1000, mobile = false, touch = false, dpr = 1 } = {}) {
  const profile = join(tmpdir(), `delta-tests-${process.pid}-${Date.now()}`);
  mkdirSync(profile, { recursive: true });
  const proc = spawn(findChrome(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--disable-site-isolation-trials', '--disable-features=IsolateOrigins,site-per-process',
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 150 && !port; i++) { try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch { await sleep(100); } }
  if (!port) { proc.kill(); throw new Error('Chrome did not open a debugging port'); }
  let target;
  for (let i = 0; i < 50 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {} if (!target) await sleep(100); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  const errors = [];
  const outside = [];
  let pageOrigin = null;
  const send = (method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
    if (m.method === 'Fetch.requestPaused') {
      const u = m.params.request.url;
      let o = null; try { o = new URL(u).origin; } catch {}
      const own = /^(data|blob|file):/i.test(u) || (pageOrigin && o === pageOrigin);
      if (own) send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
      else { outside.push(u); send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); }
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    for (const fn of listeners.get(m.method) || []) fn(m.params);
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  const b = {
    send, errors, outside,
    on(method, fn) { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn); },
    async viewport(w, h, { isMobile = mobile, hasTouch = touch, scale = dpr } = {}) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale, mobile: isMobile });
      await send('Emulation.setTouchEmulationEnabled', hasTouch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    },
    // Runs an async function body in the page; returns its JSON-able result.
    async eval(body, timeoutMs = 30000) {
      const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true, userGesture: true }, timeoutMs);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    // Navigates and waits for the page to finish loading and Delta to boot.
    async goto(url, { settle = 600 } = {}) {
      const u = new URL(url);
      pageOrigin = u.protocol === 'file:' ? null : u.origin;
      const loaded = new Promise((resolve) => { const fn = () => { resolve(); }; b.on('Page.loadEventFired', fn); });
      await send('Page.navigate', { url });
      await Promise.race([loaded, sleep(15000)]);
      await sleep(settle);
    },
    // Evaluates an expression in a child frame (the preview iframes), in an isolated world.
    async frameEval(frameId, expression) {
      const { executionContextId } = await send('Page.createIsolatedWorld', { frameId, worldName: 'probe' + Math.random().toString(36).slice(2) });
      const r = await send('Runtime.evaluate', { contextId: executionContextId, expression, returnByValue: true });
      return r.result.value;
    },
    async childFrames() { return ((await send('Page.getFrameTree')).frameTree.childFrames || []).map((f) => f.frame.id); },
    async screenshot(opts = {}) { return Buffer.from((await send('Page.captureScreenshot', { format: 'png', ...opts })).data, 'base64'); },
    async close() {
      try { await send('Browser.close', {}, 5000); } catch {}
      proc.kill();
      await sleep(300);
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    },
  };
  await b.viewport(width, height);
  // Every document records policy violations and the injection marker the probes look for.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__pwn = 0; window.pwn = 0; window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || '')));` });
  return b;
}

export { sleep };

// A tiny test reporter shared by the suites.
export function reporter(suite) {
  const results = [];
  return {
    results,
    check(name, ok, detail = '') {
      results.push({ suite, name, ok: Boolean(ok), detail });
      if ((!ok && !process.env.QUIET) || process.env.VERBOSE) console.log(`  ${ok ? 'PASS' : 'FAIL'} ${suite}: ${name}${detail && (!ok || process.env.VERBOSE) ? '  ' + detail : ''}`);
    },
  };
}
