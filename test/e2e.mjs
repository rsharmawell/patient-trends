/*
 * End-to-end harness: drives a real EHR launch through a headless browser.
 *
 *   node test/mock-ehr.mjs 8099 &
 *   node test/e2e.mjs
 *
 * Screenshots land in test/screens/.
 */

import { mkdirSync } from 'node:fs';
import { launch } from './cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:8099';
const SHOTS = new URL('./screens/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const b = await launch();
const consoleMsgs = [];
b.on((m) => {
  if (m.method === 'Runtime.consoleAPICalled') {
    consoleMsgs.push({
      type: m.params.type,
      text: m.params.args.map((a) => a.value ?? a.description ?? '').join(' '),
    });
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleMsgs.push({
      type: 'exception',
      text: m.params.exceptionDetails.exception?.description || JSON.stringify(m.params.exceptionDetails),
    });
  }
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, tries = 60, gap = 200) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await fn()) return true;
    } catch (_) { /* navigating */ }
    await wait(gap);
  }
  return false;
}

try {
  /* ---------- 1. direct visit is refused, with guidance ---------- */
  await b.goto(BASE + '/index.html');
  await wait(600);
  const directTitle = await b.eval(`document.querySelector('.screen-card h1')?.textContent ?? ''`);
  check('direct visit shows "open from the EHR"', /Open this app from the EHR/i.test(directTitle), directTitle);
  const directCode = await b.eval(`document.querySelector('.screen-code')?.textContent ?? ''`);
  check('direct visit reports NOT_LAUNCHED', directCode === 'NOT_LAUNCHED', directCode);
  check('no configuration controls exist',
    (await b.eval(`document.querySelectorAll('input,select,textarea').length`)) === 0);

  /* ---------- 2. untrusted issuer is refused ---------- */
  await b.goto(`${BASE}/launch.html?iss=${encodeURIComponent('https://evil.example.com/fhir/r4')}&launch=x`);
  await wait(900);
  const untrusted = await b.eval(`document.querySelector('.screen-code')?.textContent ?? ''`);
  check('untrusted issuer refused', untrusted === 'LAUNCH_UNTRUSTED_ISS', untrusted);
  check('still on the launch page (no redirect)', (await b.eval(`location.pathname`)) === '/launch.html');
  await b.shot(SHOTS + 'error-untrusted-issuer.png');

  /* ---------- 3. prefix-confusion issuer is refused ---------- */
  await b.goto(`${BASE}/launch.html?iss=${encodeURIComponent(BASE + '/fhir/r4.attacker.net')}&launch=x`);
  await wait(700);
  check('prefix-confusion issuer refused',
    (await b.eval(`document.querySelector('.screen-code')?.textContent ?? ''`)) === 'LAUNCH_UNTRUSTED_ISS');

  /* ---------- 4. missing launch context is refused ---------- */
  await b.goto(`${BASE}/launch.html?iss=${encodeURIComponent(BASE + '/fhir/r4')}`);
  await wait(900);
  check('missing launch context refused',
    (await b.eval(`document.querySelector('.screen-code')?.textContent ?? ''`)) === 'LAUNCH_MISSING_CONTEXT');

  /* ---------- 5. unknown launch context is rejected by the AS ---------- */
  // This one redirects on its own, so do not wait for launch.html to settle.
  await b.navigate(`${BASE}/launch.html?iss=${encodeURIComponent(BASE + '/fhir/r4')}&launch=nope`);
  await until(async () => (await b.eval(`location.pathname`)) === '/index.html');
  await wait(700);
  check('unknown launch context surfaces the AS error',
    (await b.eval(`document.querySelector('.screen-code')?.textContent ?? ''`)) === 'AUTHORIZATION_DENIED',
    await b.eval(`document.querySelector('.screen-card p')?.textContent ?? ''`));

  /* ---------- 6. the real launch, from the mock EMR ---------- */
  await b.goto(BASE + '/');
  await wait(400);
  check('mock EMR chart page renders', (await b.eval(`document.querySelectorAll('.emr-app').length`)) === 1);
  await b.shot(SHOTS + 'mock-emr.png');

  await b.eval(`document.querySelector('.emr-app a').click(); true`);
  const landed = await until(async () =>
    (await b.eval(`location.pathname`)) === '/index.html' &&
    (await b.eval(`!!document.querySelector('.topbar')`))
  );
  check('EHR launch completes into the viewer', landed);
  await wait(1200);

  /* ---------- 7. patient header ---------- */
  const name = await b.eval(`document.querySelector('.topbar h1')?.textContent ?? ''`);
  check('patient name rendered', name === 'Adaeze Okonkwo', name);
  const meta = await b.eval(`document.querySelector('.identity-meta')?.textContent ?? ''`);
  check('demographics rendered', /1974-03-02/.test(meta) && /52 y/.test(meta), meta);
  const conds = await b.eval(`document.querySelector('.identity-conditions')?.textContent ?? ''`);
  check('active conditions rendered', /Type 2 diabetes/.test(conds), conds);
  check('session expiry shown', /Signed in until/.test(await b.eval(`document.querySelector('.session')?.textContent ?? ''`)));

  /* ---------- 8. discovery + provenance ---------- */
  const prov = await b.eval(`document.querySelector('.provenance')?.textContent ?? ''`);
  check('provenance names the discovery route', /smart-configuration/.test(prov), prov.slice(0, 150));
  check('provenance counts observations', /\d+ Observation resources read/.test(prov));
  check('non-numeric observations reported', /1 non-numeric/.test(prov), prov);
  const warns = consoleMsgs.filter((m) => m.type === 'warning' && /pinned/.test(m.text));
  check('no pinned-fallback warning when discovery works', warns.length === 0, warns.map((w) => w.text).join(' | '));

  /* ---------- 9. paging actually happened ---------- */
  const obsCount = Number((prov.match(/(\d+) Observation resources read/) || [])[1]);
  check('followed Bundle next links past one page', obsCount > 200, `${obsCount} observations`);

  /* ---------- 10. rail ---------- */
  const railLabels = await b.eval(`[...document.querySelectorAll('.rail-label')].map(n=>n.textContent)`);
  console.log('   measures:', JSON.stringify(railLabels));
  check('blood pressure split into two component series',
    railLabels.some((l) => /Systolic/i.test(l)) && railLabels.some((l) => /Diastolic/i.test(l)),
    railLabels.filter((l) => /systolic|diastolic/i.test(l)).join(', '));
  check('vitals and labs both present',
    (await b.eval(`[...document.querySelectorAll('.rail-group')].map(n=>n.textContent).join('|')`)).includes('Vital signs'));
  check('every rail row has a sparkline',
    (await b.eval(`document.querySelectorAll('.rail-row .spark').length`)) === railLabels.length,
    `${await b.eval(`document.querySelectorAll('.rail-row .spark').length`)} of ${railLabels.length}`);

  /* ---------- 11. detail view ---------- */
  const hero = await b.eval(`document.querySelector('.hero-value')?.textContent ?? ''`);
  check('hero figure rendered', /\d/.test(hero), hero);
  check('exactly one hero figure in the view',
    (await b.eval(`document.querySelectorAll('.hero-value').length`)) === 1);
  const stats = await b.eval(`[...document.querySelectorAll('.stat-label')].map(n=>n.textContent)`);
  check('stat tiles present', stats.length === 4, JSON.stringify(stats));
  check('single-series chart has no legend box',
    (await b.eval(`document.querySelectorAll('.legend').length`)) === 0);
  check('reference band drawn', (await b.eval(`document.querySelectorAll('.band').length`)) >= 1);

  // The landing series happens to sit entirely above its range, which is the
  // case where a flag on every point would mark nothing.
  check('no per-point flags when every reading is out of range',
    (await b.eval(`document.querySelectorAll('.flag').length`)) === 0,
    `${await b.eval(`document.querySelectorAll('.flag').length`)} flags`);
  check('footnote explains the unflagged all-out-of-range case',
    /Every reading in this window sits (above|below) that range/.test(
      await b.eval(`document.querySelector('.footnote')?.textContent ?? ''`)));

  // Creatinine crosses its range partway through the window, so flags belong.
  await b.eval(`(() => {
    [...document.querySelectorAll('.rail-main')].find(r => /Creatinine/i.test(r.textContent)).click();
    return true; })()`);
  await wait(700);
  const flagCount = await b.eval(`document.querySelectorAll('.flag').length`);
  check('out-of-range flags drawn on a mixed series', flagCount >= 1 && flagCount < 40, `${flagCount} flags`);
  check('flags carry a surface ring so they read as markers',
    (await b.eval(`getComputedStyle(document.querySelector('.flag')).strokeWidth`)) === '1.5px');
  check('mixed series footnote describes the triangles',
    /Triangles mark readings outside it/.test(
      await b.eval(`document.querySelector('.footnote')?.textContent ?? ''`)));
  check('end marker has a surface ring',
    (await b.eval(`getComputedStyle(document.querySelector('.end-dot')).strokeWidth`)) === '2px');
  check('gridlines are solid, not dashed',
    (await b.eval(`getComputedStyle(document.querySelector('.grid')).strokeDasharray`)).replace(/none/, '') === '');
  check('direct end-label present, not a label per point',
    (await b.eval(`document.querySelectorAll('.end-label').length`)) === 1);

  // The x-axis band must be inside the rendered box, not clipped by it.
  const axisFits = await b.eval(`(() => {
    const svg = document.querySelector('.plot');
    const box = svg.getBoundingClientRect();
    const ticks = [...svg.querySelectorAll('.tick-x')];
    return ticks.length > 0 && ticks.every(t => t.getBoundingClientRect().bottom <= box.bottom + 1);
  })()`);
  check('x-axis labels fit inside the chart box', axisFits);

  /* ---------- 12. select a series with no reference range ---------- */
  await b.eval(`(() => {
    const row = [...document.querySelectorAll('.rail-main')].find(r => /Body weight/i.test(r.textContent));
    row.click(); return true; })()`);
  await wait(700);
  const noRangeSub = await b.eval(`document.querySelector('.card-sub')?.textContent ?? ''`);
  check('series without a range shows no reference text', !/reference/i.test(noRangeSub), noRangeSub);
  check('no band drawn when the record supplied none',
    (await b.eval(`document.querySelectorAll('.band').length`)) === 0);
  const footnote = await b.eval(`document.querySelector('.footnote')?.textContent ?? ''`);
  check('footnote says no range was supplied', /No reference range accompanied/.test(footnote), footnote.slice(0, 90));
  check('reference-range stat tile says "Not supplied"',
    (await b.eval(`document.querySelector('.stats')?.textContent ?? ''`)).includes('Not supplied'));

  /* ---------- 13. trend statement is conservative ---------- */
  await b.eval(`(() => {
    const row = [...document.querySelectorAll('.rail-main')].find(r => /Hemoglobin A1c/i.test(r.textContent));
    row.click(); return true; })()`);
  await wait(700);
  const trendTile = await b.eval(`(() => {
    const labels = [...document.querySelectorAll('.stat')];
    const t = labels.find(s => s.querySelector('.stat-label').textContent === 'Direction');
    return { value: t.querySelector('.stat-value').textContent, sub: t.querySelector('.stat-sub')?.textContent ?? '' };
  })()`);
  console.log('   A1c direction:', JSON.stringify(trendTile));
  check('trend reports a direction with its fit quality',
    /Rising|Falling|Stable|No clear trend/.test(trendTile.value) && /R²|readings/.test(trendTile.sub),
    JSON.stringify(trendTile));

  const noiseTrend = await b.eval(`(() => {
    const row = [...document.querySelectorAll('.rail-main')].find(r => /Sodium/i.test(r.textContent));
    row.click(); return true; })()`);
  await wait(700);
  const sodium = await b.eval(`(() => {
    const t = [...document.querySelectorAll('.stat')].find(s => s.querySelector('.stat-label').textContent === 'Direction');
    return t.querySelector('.stat-value').textContent; })()`);
  check('a noisy flat series is not given a direction', /Stable|No clear trend/.test(sodium), sodium);

  /* ---------- 14. crosshair tooltip + keyboard ---------- */
  await b.eval(`(() => {
    const row = [...document.querySelectorAll('.rail-main')].find(r => /Hemoglobin A1c/i.test(r.textContent));
    row.click(); return true; })()`);
  await wait(700);
  const hit = await b.eval(`(() => {
    const r = document.querySelector('.hit').getBoundingClientRect();
    return { x: Math.round(r.left + r.width * 0.55), y: Math.round(r.top + r.height / 2) }; })()`);
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.x, y: hit.y });
  await wait(300);
  const tip = await b.eval(`(() => {
    const t = document.querySelector('.tip');
    return t && !t.classList.contains('hidden') ? t.textContent : ''; })()`);
  check('crosshair tooltip shows a dated value', /\d/.test(tip) && tip.length > 4, tip);
  check('crosshair line visible',
    (await b.eval(`!document.querySelector('.crosshair').classList.contains('hidden')`)));

  await b.eval(`document.querySelector('.hit').focus(); true`);
  await wait(200);
  const focusTip = await b.eval(`!document.querySelector('.tip').classList.contains('hidden')`);
  check('keyboard focus shows the same readout', focusTip);
  await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 37, key: 'ArrowLeft', code: 'ArrowLeft' });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 37, key: 'ArrowLeft', code: 'ArrowLeft' });
  await wait(250);
  check('arrow keys step the crosshair',
    (await b.eval(`document.querySelector('.tip-date')?.textContent ?? ''`)).length > 4);

  await b.shot(SHOTS + 'detail-light.png');

  /* ---------- 15. table view twin ---------- */
  await b.eval(`document.querySelector('.switch input').click(); true`);
  await wait(600);
  const tableRows = await b.eval(`document.querySelectorAll('table.values tbody tr').length`);
  check('table view lists every reading', tableRows > 10, `${tableRows} rows`);
  const tableHead = await b.eval(`[...document.querySelectorAll('table.values th')].map(n=>n.textContent).join('|')`);
  check('table carries value, flag and range', tableHead === 'Date|Value|Flag|Reference range', tableHead);
  await b.shot(SHOTS + 'table-view.png');
  await b.eval(`document.querySelector('.switch input').click(); true`);
  await wait(400);

  /* ---------- 16. compare / overlay ---------- */
  await b.eval(`(() => {
    const rows = [...document.querySelectorAll('.rail-row')];
    const pick = (re) => rows.find(r => re.test(r.textContent))?.querySelector('.rail-compare');
    pick(/Hemoglobin A1c/i)?.click();
    return true; })()`);
  await wait(500);
  await b.eval(`(() => {
    const rows = [...document.querySelectorAll('.rail-row')];
    rows.find(r => /Body weight/i.test(r.textContent))?.querySelector('.rail-compare')?.click();
    return true; })()`);
  await wait(900);
  check('two picks switch to the compare view',
    (await b.eval(`document.querySelector('.card-head h2')?.textContent ?? ''`)) === 'Compare measures');
  check('legend present for two series',
    (await b.eval(`document.querySelectorAll('.legend-item').length`)) === 2);
  check('single shared axis, values indexed to baseline',
    (await b.eval(`[...document.querySelectorAll('.tick-y')].every(t => t.textContent.includes('%'))`)));
  check('no area wash with multiple series',
    (await b.eval(`document.querySelectorAll('.area').length`)) === 0);
  check('each series has its own end label',
    (await b.eval(`document.querySelectorAll('.end-label').length`)) === 2);
  await b.shot(SHOTS + 'compare.png');

  // Cap at three.
  await b.eval(`(() => {
    const rows = [...document.querySelectorAll('.rail-row')];
    rows.find(r => /LDL/i.test(r.textContent))?.querySelector('.rail-compare')?.click();
    return true; })()`);
  await wait(700);
  await b.eval(`(() => {
    const rows = [...document.querySelectorAll('.rail-row')];
    rows.find(r => /Creatinine/i.test(r.textContent))?.querySelector('.rail-compare')?.click();
    return true; })()`);
  await wait(900);
  check('compare is capped at three series',
    (await b.eval(`document.querySelectorAll('.legend-item').length`)) === 3,
    `${await b.eval(`document.querySelectorAll('.legend-item').length`)} in legend`);

  /* ---------- 17. small multiples ---------- */
  await b.eval(`(() => {
    [...document.querySelectorAll('.seg-btn')].find(b => b.textContent === 'All measures').click();
    return true; })()`);
  await wait(900);
  const facets = await b.eval(`document.querySelectorAll('.facet').length`);
  check('small multiples render one facet per measure', facets >= 10, `${facets} facets`);
  check('facets carry a trend word',
    (await b.eval(`document.querySelectorAll('.facet-trend').length`)) === facets);
  await b.shot(SHOTS + 'all-measures.png');

  await b.eval(`document.querySelector('.facet').click(); true`);
  await wait(700);
  check('clicking a facet opens its detail view',
    (await b.eval(`document.querySelectorAll('.hero-value').length`)) === 1);

  /* ---------- 18. time range scopes everything ---------- */
  const before = await b.eval(`document.querySelector('.stats').textContent`);
  await b.eval(`(() => {
    [...document.querySelectorAll('.seg-btn')].find(b => b.textContent === '1 year').click();
    return true; })()`);
  await wait(900);
  const after = await b.eval(`document.querySelector('.stats').textContent`);
  check('changing the time range re-renders the stats', before !== after);
  const readings = await b.eval(`(() => {
    const t = [...document.querySelectorAll('.stat')].find(s => s.querySelector('.stat-label').textContent === 'Readings');
    return t.querySelector('.stat-sub').textContent; })()`);
  check('window reflected in the readings tile', /months|days|1\.0 years/.test(readings), readings);
  await b.eval(`(() => {
    [...document.querySelectorAll('.seg-btn')].find(b => b.textContent === '5 years').click();
    return true; })()`);
  await wait(800);

  /* ---------- 19. rail filter ---------- */
  await b.eval(`(() => {
    const input = document.querySelector('.rail-search input');
    input.value = 'creat';
    input.dispatchEvent(new Event('input'));
    return true; })()`);
  await wait(400);
  check('rail filter narrows the list',
    (await b.eval(`document.querySelectorAll('.rail-label').length`)) === 1,
    await b.eval(`document.querySelector('.rail-label')?.textContent ?? ''`));
  await b.eval(`(() => {
    const input = document.querySelector('.rail-search input');
    input.value = ''; input.dispatchEvent(new Event('input')); return true; })()`);
  await wait(300);

  /* ---------- 20. dark mode ---------- */
  await b.eval(`document.documentElement.dataset.theme = 'dark'; true`);
  await wait(500);
  const darkSurface = await b.eval(`getComputedStyle(document.body).backgroundColor`);
  check('dark mode uses the selected dark plane', darkSurface === 'rgb(13, 13, 13)', darkSurface);
  const darkSeries = await b.eval(`getComputedStyle(document.documentElement).getPropertyValue('--series-1').trim()`);
  check('dark mode uses its own series step, not the light one', darkSeries === '#3987e5', darkSeries);
  await b.shot(SHOTS + 'detail-dark.png');
  await b.eval(`document.documentElement.dataset.theme = 'light'; true`);
  await wait(300);

  /* ---------- 21. sign out ---------- */
  await b.eval(`[...document.querySelectorAll('.btn')].find(b => b.textContent === 'Sign out').click(); true`);
  await wait(600);
  check('sign out shows the session-ended screen',
    (await b.eval(`document.querySelector('.screen-card h1')?.textContent ?? ''`)) === 'Session ended');
  check('sign out clears the stored session',
    (await b.eval(`sessionStorage.getItem('polaris.pv.session')`)) === null);
  await b.shot(SHOTS + 'session-ended.png');

  /* ---------- 22. reload after sign out does not resurrect it ---------- */
  await b.goto(BASE + '/index.html');
  await wait(600);
  check('reload after sign out returns to the launch prompt',
    (await b.eval(`document.querySelector('.screen-code')?.textContent ?? ''`)) === 'NOT_LAUNCHED');

  /* ---------- 23. console hygiene ---------- */
  // Steps 2–4 deliberately provoke refusals, and the app is supposed to log
  // them. Anything else on the error channel is a real problem.
  const EXPECTED = /LAUNCH_UNTRUSTED_ISS|LAUNCH_MISSING_CONTEXT|AUTHORIZATION_DENIED|401|403|404|Failed to load resource|net::ERR|invalid_request|unknown launch/;
  const bad = consoleMsgs.filter(
    (m) => (m.type === 'error' || m.type === 'exception') && !EXPECTED.test(m.text)
  );
  check('no unexpected console errors', bad.length === 0, bad.slice(0, 4).map((m) => m.text).join(' | '));
} catch (err) {
  check('harness completed', false, err.message);
} finally {
  b.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILURES:');
  for (const f of failed) console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : ''));
  process.exit(1);
}
