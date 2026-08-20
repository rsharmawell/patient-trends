/*
 * Second harness: the session and discovery behaviour that the main harness
 * does not cover, because each case needs the mock started differently.
 *
 *   node test/e2e-session.mjs
 *
 * Every phase restarts the mock on the same port (8099) with different flags,
 * because that port is the one config.js trusts as an issuer — an EHR launch
 * from an unlisted origin is refused, which is the point of trustedIssuers.
 * Nothing else should be listening on 8099.
 */

import { spawn } from 'node:child_process';
import { launch } from './cdp.mjs';

const PORT = 8099;
const BASE = `http://localhost:${PORT}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function startMock(port, env) {
  const proc = spawn(process.execPath, [new URL('./mock-ehr.mjs', import.meta.url).pathname, String(port)], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve) => {
    proc.stdout.on('data', (d) => {
      if (String(d).includes('mock EMR')) resolve(proc);
    });
    setTimeout(() => resolve(proc), 2500);
  });
}

async function until(b, fn, tries = 80, gap = 200) {
  for (let i = 0; i < tries; i++) {
    try { if (await fn()) return true; } catch (_) {}
    await wait(gap);
  }
  return false;
}

async function launchInto(b, base) {
  await b.goto(base + '/');
  await wait(300);
  await b.eval(`document.querySelector('.emr-app a').click(); true`);
  return until(b, async () =>
    (await b.eval(`location.pathname`)) === '/index.html' &&
    (await b.eval(`!!document.querySelector('.topbar') || !!document.querySelector('.screen-card')`))
  );
}

const mocks = [];
const b = await launch();
const consoleMsgs = [];
const tokenPosts = [];
b.on((m) => {
  if (m.method === 'Runtime.consoleAPICalled') {
    consoleMsgs.push({
      type: m.params.type,
      text: m.params.args.map((a) => a.value ?? a.description ?? '').join(' '),
    });
  }
  if (m.method === 'Network.requestWillBeSent' && m.params.request.method === 'POST' &&
      m.params.request.url.includes('/oauth/token')) {
    tokenPosts.push({ url: m.params.request.url, body: m.params.request.postData || '' });
  }
});

try {
  /* ================= 1. discovery hidden → pinned fallback ================= */
  mocks.push(await startMock(PORT, { MOCK_HIDE_DISCOVERY: '1' }));
  const ok1 = await launchInto(b, BASE);
  await wait(1500);
  check('launch still succeeds when the server advertises no SMART endpoints', ok1 &&
    (await b.eval(`!!document.querySelector('.topbar')`)));
  const warned = consoleMsgs.filter((m) => m.type === 'warning' && /falling back to endpoints pinned/.test(m.text));
  check('fallback is logged as a warning, not silently used', warned.length === 1,
    warned[0]?.text?.slice(0, 120) || `${warned.length} warnings`);
  const prov = await b.eval(`document.querySelector('.provenance')?.textContent ?? ''`);
  check('provenance names the fallback route', /pinned-fallback/.test(prov), prov.slice(-70));
  check('data still loaded through the fallback',
    (await b.eval(`document.querySelectorAll('.rail-label').length`)) >= 10);

  mocks.pop().kill();
  await wait(1200);

  /* ================= 2. silent refresh before expiry ================= */
  // 70s token with a 60s refresh lead means the first refresh is due ~10s in.
  mocks.push(await startMock(PORT, { MOCK_SHORT_TOKEN: '70' }));
  tokenPosts.length = 0;
  const ok2 = await launchInto(b, BASE);
  await wait(1200);
  check('launched against the short-lived-token mock', ok2 &&
    (await b.eval(`!!document.querySelector('.topbar')`)));
  const codeExchanges = tokenPosts.filter((p) => p.body.includes('authorization_code')).length;
  check('one authorization-code exchange', codeExchanges === 1, `${codeExchanges}`);

  const refreshed = await until(b, async () =>
    tokenPosts.some((p) => p.body.includes('grant_type=refresh_token')), 90, 400);
  check('access token is refreshed silently before it expires', refreshed,
    `${tokenPosts.length} token POSTs`);
  check('the view survived the refresh without a reload',
    (await b.eval(`!!document.querySelector('.hero-value')`)));
  const stillValid = await b.eval(`(() => {
    const raw = sessionStorage.getItem('polaris.pv.session');
    if (!raw) return false;
    return JSON.parse(raw).expiresAt - Date.now() > 30000; })()`);
  check('stored session carries the new expiry', stillValid);

  mocks.pop().kill();
  await wait(1200);

  /* ================= 3. no refresh token → session ends ================= */
  mocks.push(await startMock(PORT, { MOCK_NO_REFRESH: '1', MOCK_SHORT_TOKEN: '65' }));
  const ok3 = await launchInto(b, BASE);
  await wait(1200);
  check('launched against the no-refresh mock', ok3);
  const noRefreshWarn = consoleMsgs.some((m) =>
    m.type === 'warning' && /did not issue a refresh token/.test(m.text));
  check('missing refresh token is warned about at launch', noRefreshWarn);

  const ended = await until(b, async () =>
    (await b.eval(`document.querySelector('.screen-card h1')?.textContent ?? ''`)) === 'Session ended',
    90, 400);
  check('session ends cleanly when it cannot be renewed', ended);
  check('the ended screen names the reason',
    (await b.eval(`document.querySelector('.screen-code')?.textContent ?? ''`)) === 'TOKEN_EXPIRED',
    await b.eval(`document.querySelector('.screen-code')?.textContent ?? ''`));
  check('token is gone from storage',
    (await b.eval(`sessionStorage.getItem('polaris.pv.session')`)) === null);

  mocks.pop().kill();
  await wait(1200);

  /* ================= 4. idle timeout ================= */
  mocks.push(await startMock(PORT, {}));
  const ok4 = await launchInto(b, BASE);
  await wait(1200);
  check('launched for the idle test', ok4 && (await b.eval(`!!document.querySelector('.topbar')`)));

  // Shorten the idle policy in the live module, then poke the page once so the
  // timer is rescheduled against the new value.
  await b.eval(`(async () => {
    const { CONFIG } = await import('/config.js');
    CONFIG.session.idleTimeoutSeconds = 1;
    CONFIG.session.idleGraceSeconds = 3;
    window.dispatchEvent(new Event('keydown'));
    return CONFIG.session.idleTimeoutSeconds; })()`);

  const warnedIdle = await until(b, async () => b.eval(`!!document.getElementById('idleWarning')`), 40, 200);
  check('idle warning appears before the session is dropped', warnedIdle);
  const idleText = await b.eval(`document.getElementById('idleWarning')?.textContent ?? ''`);
  check('warning explains why and counts down', /Still there\?/.test(idleText) && /seconds/.test(idleText), idleText.slice(0, 70));

  // "Keep working" must cancel it.
  await b.eval(`document.querySelector('#idleWarning button').click(); true`);
  await wait(400);
  check('"Keep working" dismisses the warning',
    (await b.eval(`!document.getElementById('idleWarning')`)));
  check('session survives the dismissal',
    (await b.eval(`!!document.querySelector('.topbar')`)));

  // Let it run out this time.
  await b.eval(`(async () => {
    const { CONFIG } = await import('/config.js');
    CONFIG.session.idleTimeoutSeconds = 1;
    CONFIG.session.idleGraceSeconds = 1;
    window.dispatchEvent(new Event('keydown'));
    return true; })()`);
  const idleEnded = await until(b, async () =>
    (await b.eval(`document.querySelector('.screen-code')?.textContent ?? ''`)) === 'IDLE_TIMEOUT', 60, 200);
  check('session ends on idle timeout', idleEnded);
  check('idle end clears storage',
    (await b.eval(`sessionStorage.getItem('polaris.pv.session')`)) === null);
} catch (err) {
  check('harness completed', false, err.message);
} finally {
  b.close();
  for (const m of mocks) m.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILURES:');
  for (const f of failed) console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : ''));
  process.exit(1);
}
