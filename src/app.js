/*
 * Application shell and views.
 *
 * There is no configuration surface here: the app is either launched from an
 * EHR or it shows an error. Every view below assumes a valid session and a
 * patient in context.
 */

import { CONFIG } from '../config.js';
import {
  AppError, SessionManager, clearSession, completeLaunch, decodeJwt, restoreSession,
} from './smart.js';
import { FhirClient } from './fhir.js';
import {
  TIME_RANGES, buildSeries, fmtDate, fmtSigned, fmtSpan, fmtValue, fmtNumber,
  indexToBaseline, summarise, windowPoints,
} from './observations.js';
import {
  MAX_OVERLAY, el, lineChart, rangeText, seriesColorVar, sparkline, statusWord, valueTable,
} from './chart.js';
import { error as logError, info } from './log.js';

const root = () => document.getElementById('root');

const state = {
  session: null,
  manager: null,
  client: null,
  patient: null,
  conditions: [],
  series: [],
  meta: { skipped: 0, nonNumeric: 0, observations: 0, truncated: false },
  rangeId: '3y',
  view: 'detail',
  selectedKey: null,
  compareKeys: [],
  showTable: false,
  query: '',
};

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

export async function boot() {
  const query = new URLSearchParams(location.search);

  try {
    if (query.get('code') || query.get('error') || query.get('state')) {
      renderStatus('Completing sign-in', 'Exchanging the authorization code.');
      state.session = await completeLaunch(query);
      // Drop the code from the address bar so a reload cannot replay it.
      history.replaceState({}, '', location.pathname);
    } else {
      state.session = restoreSession();
    }

    if (!state.session) {
      renderError(
        new AppError(
          'NOT_LAUNCHED',
          'Open this app from the EHR',
          'This is an EHR-launched SMART application. It has no sign-in of its own and no ' +
            'settings to configure — open a patient in the EHR and start the app from there.'
        ),
        { quiet: true }
      );
      return;
    }

    startSession();
    renderStatus('Loading patient', 'Reading the clinical record.');
    await loadData();
    render();
  } catch (err) {
    if (err instanceof AppError) renderError(err);
    else {
      logError(err);
      renderError(
        new AppError('UNEXPECTED', 'Something went wrong', String(err?.message || err))
      );
    }
  }
}

function startSession() {
  state.manager = new SessionManager(state.session, {
    onExpired: (reason) => {
      state.manager = null;
      renderSessionEnded(reason);
    },
    onIdleWarning: (seconds) => showIdleWarning(seconds),
    onIdleCleared: () => hideIdleWarning(),
  });
  state.manager.start();

  state.client = new FhirClient(
    state.session.fhirBaseUrl,
    () => state.manager?.token() ?? null,
    () => state.manager?.expire('TOKEN_REJECTED')
  );
}

async function loadData() {
  const patientId = state.session.patientId;

  // Patient first: without it there is nothing to show, and its failure is the
  // clearest signal that scopes or patient context are wrong.
  state.patient = await state.client.read('Patient', patientId);

  const [obsResult, condResult] = await Promise.all([
    state.client.searchAll('Observation', {
      patient: patientId,
      category: CONFIG.data.categories.join(','),
      _sort: 'date',
    }),
    // Conditions are context for the header, not the point of the app — a
    // failure here should not take the viewer down with it.
    state.client
      .searchAll('Condition', { patient: patientId })
      .catch(() => ({ resources: [], truncated: false })),
  ]);

  const built = buildSeries(obsResult.resources);
  state.series = built.series;
  state.conditions = condResult.resources;
  state.meta = {
    skipped: built.skipped,
    nonNumeric: built.nonNumeric,
    observations: obsResult.resources.length,
    truncated: obsResult.truncated,
  };

  const withTrend = state.series.filter(
    (s) => s.points.length >= CONFIG.data.minPointsForTrend
  );
  state.selectedKey = (withTrend[0] || state.series[0])?.key ?? null;
  info(
    `${state.meta.observations} observations → ${state.series.length} series`,
    `(${withTrend.length} with enough points to trend)`
  );
}

/* ------------------------------------------------------------------ *
 * Status / error / ended screens
 * ------------------------------------------------------------------ */

function renderStatus(title, detail) {
  const host = root();
  host.textContent = '';
  host.appendChild(
    el('div', { class: 'screen' }, [
      el('div', { class: 'screen-card' }, [
        el('div', { class: 'spinner', 'aria-hidden': 'true' }),
        el('h1', { text: title }),
        el('p', { text: detail }),
      ]),
    ])
  );
}

function renderError(err, { quiet = false } = {}) {
  if (!quiet) logError(err.code, err.title, err.detail);
  const host = root();
  host.textContent = '';
  host.appendChild(
    el('div', { class: 'screen' }, [
      el('div', { class: `screen-card ${quiet ? '' : 'screen-card-error'}` }, [
        el('div', { class: 'screen-mark', text: quiet ? '⌘' : '!' }),
        el('h1', { text: err.title }),
        el('p', { text: err.detail }),
        el('p', { class: 'screen-code', text: err.code }),
      ]),
    ])
  );
}

function renderSessionEnded(reason) {
  clearSession();
  const detail =
    reason === 'IDLE_TIMEOUT'
      ? 'The session was closed after a period of inactivity. Open the patient again from the EHR to continue.'
      : 'The access token expired and could not be renewed. Open the patient again from the EHR to continue.';
  const host = root();
  host.textContent = '';
  host.appendChild(
    el('div', { class: 'screen' }, [
      el('div', { class: 'screen-card' }, [
        el('div', { class: 'screen-mark', text: '⏻' }),
        el('h1', { text: 'Session ended' }),
        el('p', { text: detail }),
        el('p', { class: 'screen-code', text: reason }),
      ]),
    ])
  );
}

/* ------------------------------------------------------------------ *
 * Idle warning
 * ------------------------------------------------------------------ */

let idleInterval = null;

function showIdleWarning(seconds) {
  hideIdleWarning();
  let left = seconds;
  const count = el('strong', { text: String(left) });
  const bar = el('div', { class: 'idle-bar-fill' });
  const modal = el('div', { class: 'idle', id: 'idleWarning', role: 'alertdialog', 'aria-live': 'assertive' }, [
    el('div', { class: 'idle-card' }, [
      el('h2', { text: 'Still there?' }),
      el('p', {}, [
        document.createTextNode('This session will close in '),
        count,
        document.createTextNode(' seconds to protect patient information.'),
      ]),
      el('div', { class: 'idle-bar' }, bar),
      el('button', {
        class: 'btn btn-primary',
        onclick: () => state.manager?.noteActivity(),
        text: 'Keep working',
      }),
    ]),
  ]);
  document.body.appendChild(modal);
  modal.querySelector('button')?.focus();

  idleInterval = setInterval(() => {
    left -= 1;
    count.textContent = String(Math.max(left, 0));
    bar.style.width = `${Math.max((left / seconds) * 100, 0)}%`;
  }, 1000);
}

function hideIdleWarning() {
  clearInterval(idleInterval);
  idleInterval = null;
  document.getElementById('idleWarning')?.remove();
}

/* ------------------------------------------------------------------ *
 * Main render
 * ------------------------------------------------------------------ */

function render() {
  const host = root();
  host.textContent = '';
  host.appendChild(renderHeader());
  host.appendChild(renderFilters());

  if (!state.series.length) {
    host.appendChild(
      el('div', { class: 'card' }, [
        el('p', {
          class: 'empty',
          text:
            state.meta.observations === 0
              ? 'This patient has no vital-sign or laboratory observations in the record.'
              : `Read ${state.meta.observations} observations, but none carried a numeric value that could be trended.`,
        }),
      ])
    );
    host.appendChild(renderProvenance());
    return;
  }

  const layout = el('div', { class: 'layout' });
  layout.appendChild(renderRail());
  layout.appendChild(el('section', { class: 'detail', id: 'detail' }));
  host.appendChild(layout);
  host.appendChild(renderProvenance());
  renderDetail();
}

function renderHeader() {
  const p = state.patient || {};
  const name = p.name?.[0];
  const display = name
    ? [name.given?.join(' '), name.family].filter(Boolean).join(' ') || name.text || '(no name)'
    : '(no name)';

  const bits = [];
  if (p.gender) bits.push(cap(p.gender));
  if (p.birthDate) bits.push(`${p.birthDate} (${age(p.birthDate)})`);
  const mrn = (p.identifier || []).find((i) => i.value);
  if (mrn) bits.push(`${mrn.type?.text || 'ID'} ${mrn.value}`);

  const active = state.conditions.filter(
    (c) => (c.clinicalStatus?.coding?.[0]?.code || c.clinicalStatus?.text || '').toLowerCase() === 'active'
  );

  const fhirUser = state.session.fhirUser || decodeJwt(state.session.accessToken)?.fhirUser;

  return el('header', { class: 'topbar' }, [
    el('div', { class: 'identity' }, [
      el('div', { class: 'avatar', text: initials(display), 'aria-hidden': 'true' }),
      el('div', {}, [
        el('h1', { text: display }),
        el('p', { class: 'identity-meta', text: bits.join('  ·  ') }),
        active.length
          ? el('p', {
              class: 'identity-conditions',
              text: active
                .slice(0, 4)
                .map((c) => c.code?.text || c.code?.coding?.[0]?.display || 'Condition')
                .join(' · ') + (active.length > 4 ? ` · +${active.length - 4} more` : ''),
            })
          : null,
      ]),
    ]),
    el('div', { class: 'topbar-right' }, [
      el('div', { class: 'session' }, [
        el('span', { class: 'session-line', text: fhirUser ? shortRef(fhirUser) : 'Clinician session' }),
        el('span', {
          class: 'session-line session-dim',
          text: `Signed in until ${new Date(state.session.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        }),
      ]),
      el('button', {
        class: 'btn btn-ghost',
        text: 'Sign out',
        onclick: () => state.manager?.expire('SIGNED_OUT'),
      }),
    ]),
  ]);
}

function renderFilters() {
  const bar = el('div', { class: 'filters' });

  bar.appendChild(
    el('div', { class: 'seg', role: 'group', 'aria-label': 'Time range' },
      TIME_RANGES.map((r) =>
        el('button', {
          class: `seg-btn${state.rangeId === r.id ? ' active' : ''}`,
          text: r.label,
          'aria-pressed': String(state.rangeId === r.id),
          onclick: () => { state.rangeId = r.id; render(); },
        })
      )
    )
  );

  bar.appendChild(
    el('div', { class: 'seg', role: 'group', 'aria-label': 'View' }, [
      ['detail', 'Detail'],
      ['overlay', `Compare${state.compareKeys.length ? ` (${state.compareKeys.length})` : ''}`],
      ['grid', 'All measures'],
    ].map(([id, label]) =>
      el('button', {
        class: `seg-btn${state.view === id ? ' active' : ''}`,
        text: label,
        'aria-pressed': String(state.view === id),
        onclick: () => { state.view = id; renderDetail(); syncFilters(); },
      })
    ))
  );

  bar.appendChild(el('div', { class: 'filters-spacer' }));
  bar.appendChild(
    el('label', { class: 'switch' }, [
      el('input', {
        type: 'checkbox',
        ...(state.showTable ? { checked: 'checked' } : {}),
        onchange: (e) => { state.showTable = e.target.checked; renderDetail(); },
      }),
      el('span', { text: 'Table view' }),
    ])
  );

  return bar;
}

function syncFilters() {
  const old = document.querySelector('.filters');
  if (old) old.replaceWith(renderFilters());
}

/* ---------------- rail ---------------- */

function renderRail() {
  const rail = el('aside', { class: 'rail' });

  rail.appendChild(
    el('div', { class: 'rail-search' }, [
      el('input', {
        type: 'search',
        placeholder: 'Filter measures',
        'aria-label': 'Filter measures',
        value: state.query,
        oninput: (e) => {
          state.query = e.target.value;
          const list = rail.querySelector('.rail-list');
          list.replaceWith(renderRailList());
        },
      }),
    ])
  );
  rail.appendChild(renderRailList());
  return rail;
}

function visibleSeries() {
  const q = state.query.trim().toLowerCase();
  return state.series.filter((s) => !q || s.label.toLowerCase().includes(q) || (s.loinc || '').includes(q));
}

function renderRailList() {
  const list = el('div', { class: 'rail-list', role: 'listbox', 'aria-label': 'Measures' });
  const rows = visibleSeries();

  if (!rows.length) {
    list.appendChild(el('p', { class: 'empty', text: 'No measure matches that filter.' }));
    return list;
  }

  let lastCategory = null;
  for (const s of rows) {
    if (s.category !== lastCategory) {
      lastCategory = s.category;
      list.appendChild(el('div', { class: 'rail-group', text: categoryLabel(s.category) }));
    }

    const pts = windowPoints(s, state.rangeId);
    const stats = summarise(s, pts);
    const selected = s.key === state.selectedKey;
    const comparing = state.compareKeys.includes(s.key);

    const row = el('div', { class: `rail-row${selected ? ' selected' : ''}`, role: 'option', 'aria-selected': String(selected) });

    const main = el('button', {
      class: 'rail-main',
      // The rail is narrow, so long LOINC display names ellipsize. The title
      // gives the full name back without widening the column.
      title: `${s.label}${s.unit ? ` (${s.unit})` : ''}`,
      onclick: () => {
        state.selectedKey = s.key;
        state.view = 'detail';
        render();
      },
    }, [
      el('span', { class: 'rail-label', text: s.label }),
      el('span', { class: 'rail-value' }, [
        stats.empty
          ? el('span', { class: 'rail-novalue', text: 'no readings' })
          : el('span', { text: fmtValue(stats.last.v, s.unit) }),
        stats.empty || stats.lastStatus === 'unknown' || stats.lastStatus === 'in-range'
          ? null
          : el('span', { class: `pill pill-${stats.lastStatus}`, text: statusWord(stats.lastStatus) }),
      ]),
    ]);

    if (!stats.empty && pts.length > 1) main.appendChild(sparkline(pts));
    row.appendChild(main);

    row.appendChild(
      el('button', {
        class: `rail-compare${comparing ? ' on' : ''}`,
        title: comparing ? 'Remove from comparison' : 'Add to comparison',
        'aria-label': comparing ? `Remove ${s.label} from comparison` : `Add ${s.label} to comparison`,
        'aria-pressed': String(comparing),
        text: comparing ? '−' : '+',
        onclick: () => toggleCompare(s.key),
      })
    );

    list.appendChild(row);
  }
  return list;
}

function toggleCompare(key) {
  const at = state.compareKeys.indexOf(key);
  if (at >= 0) state.compareKeys.splice(at, 1);
  else {
    if (state.compareKeys.length >= MAX_OVERLAY) state.compareKeys.shift();
    state.compareKeys.push(key);
  }
  if (state.compareKeys.length >= 2) state.view = 'overlay';
  render();
}

/* ---------------- detail ---------------- */

function renderDetail() {
  const host = document.getElementById('detail');
  if (!host) return;
  host.textContent = '';

  if (state.view === 'grid') return renderGrid(host);
  if (state.view === 'overlay') return renderOverlay(host);
  return renderSingle(host);
}

function renderSingle(host) {
  const s = state.series.find((x) => x.key === state.selectedKey) || state.series[0];
  if (!s) return;
  const pts = windowPoints(s, state.rangeId);
  const stats = summarise(s, pts);

  const card = el('div', { class: 'card' });

  card.appendChild(
    el('div', { class: 'card-head' }, [
      el('div', {}, [
        el('h2', { text: s.label }),
        el('p', { class: 'card-sub', text: measureSubtitle(s, stats) }),
      ]),
      stats.empty || stats.lastStatus === 'unknown'
        ? null
        : el('span', { class: `pill pill-lg pill-${stats.lastStatus}`, text: statusWord(stats.lastStatus) }),
    ])
  );

  if (stats.empty) {
    card.appendChild(el('p', { class: 'empty', text: `No readings for ${s.label} in the last ${rangeLabel()}.` }));
    host.appendChild(card);
    return;
  }

  // The one hero figure in this view: the latest reading.
  card.appendChild(
    el('div', { class: 'hero' }, [
      el('div', {}, [
        el('div', { class: 'hero-value', text: fmtValue(stats.last.v, s.unit) }),
        el('div', { class: 'hero-label', text: `Latest · ${fmtDate(stats.last.t)}` }),
      ]),
      el('div', { class: 'stats' }, [
        statTile('Change over window', fmtSigned(stats.delta, s.unit),
          stats.deltaPct != null ? `${stats.deltaPct > 0 ? '+' : '−'}${fmtNumber(Math.abs(stats.deltaPct), 1)}% from ${fmtDate(stats.first.t)}` : null),
        statTile('Direction', trendHeadline(stats, s.unit), trendDetail(stats)),
        statTile('Readings', String(stats.n), `over ${fmtSpan(stats.spanDays)}`),
        stats.hasRange
          ? statTile('Within reference range', stats.inRangePct == null ? '—' : `${stats.inRangePct}%`,
              `${stats.outOfRange} of ${stats.n} flagged`)
          : statTile('Reference range', 'Not supplied', 'the record did not assert one'),
      ]),
    ])
  );

  const chartHost = el('div', { class: 'chart-host' });
  card.appendChild(chartHost);

  // A flag marks the exception. When every reading is out of range there is no
  // exception to mark, so the per-point triangles are dropped and the footnote
  // says it in words instead.
  const allOutOfRange = stats.hasRange && stats.outOfRange === stats.n;

  if (state.showTable) {
    chartHost.appendChild(valueTable([{ ...s, points: pts }], { band: stats.range }));
  } else {
    lineChart(chartHost, {
      series: [{ key: s.key, label: s.label, unit: s.unit, points: pts, colorVar: seriesColorVar(0) }],
      band: stats.hasRange ? stats.range : null,
      flagPoints: !allOutOfRange,
      yLabel: `${s.label}${s.unit ? ` (${s.unit})` : ''}`,
    });
    card.appendChild(chartFooter(s, stats, { allOutOfRange }));
  }

  host.appendChild(card);
}

function renderOverlay(host) {
  const picked = state.compareKeys
    .map((k) => state.series.find((s) => s.key === k))
    .filter(Boolean)
    .slice(0, MAX_OVERLAY);

  const card = el('div', { class: 'card' });
  card.appendChild(
    el('div', { class: 'card-head' }, [
      el('div', {}, [
        el('h2', { text: 'Compare measures' }),
        el('p', {
          class: 'card-sub',
          text:
            'Every series is indexed to its own first reading in this window and plotted as ' +
            'percent change, so measures on different scales share one axis. Two y-axes would ' +
            'invent a relationship the data does not contain.',
        }),
      ]),
    ])
  );

  if (picked.length < 2) {
    card.appendChild(
      el('p', {
        class: 'empty',
        text: `Add ${2 - picked.length} more measure${picked.length === 1 ? '' : 's'} with the + button in the list to compare (up to ${MAX_OVERLAY}).`,
      })
    );
    host.appendChild(card);
    return;
  }

  const prepared = picked
    .map((s, i) => {
      const pts = indexToBaseline(windowPoints(s, state.rangeId));
      return { key: s.key, label: s.label, unit: s.unit, points: pts, colorVar: seriesColorVar(i) };
    })
    .filter((s) => s.points.length > 1);

  if (prepared.length < 2) {
    card.appendChild(el('p', { class: 'empty', text: 'Not enough readings in this window to compare.' }));
    host.appendChild(card);
    return;
  }

  // A legend is always present for two or more series.
  card.appendChild(
    el('div', { class: 'legend' },
      prepared.map((s) => {
        const key = el('span', { class: 'legend-key' });
        key.style.background = `var(${s.colorVar})`;
        return el('span', { class: 'legend-item' }, [
          key,
          el('span', { text: `${s.label}${s.unit ? ` (${s.unit})` : ''}` }),
          el('span', { class: 'legend-base', text: `baseline ${fmtValue(s.points[0].v, s.unit)}` }),
        ]);
      })
    )
  );

  const chartHost = el('div', { class: 'chart-host' });
  card.appendChild(chartHost);
  if (state.showTable) {
    chartHost.appendChild(valueTable(prepared, { mode: 'indexed' }));
  } else {
    lineChart(chartHost, { series: prepared, mode: 'indexed', yLabel: 'Percent change from baseline' });
  }

  host.appendChild(card);
}

function renderGrid(host) {
  const rows = visibleSeries()
    .map((s) => ({ s, pts: windowPoints(s, state.rangeId) }))
    .filter(({ pts }) => pts.length >= 2);

  const card = el('div', { class: 'card' });
  card.appendChild(
    el('div', { class: 'card-head' }, [
      el('div', {}, [
        el('h2', { text: 'All measures' }),
        el('p', {
          class: 'card-sub',
          text: `${rows.length} measure${rows.length === 1 ? '' : 's'} with at least two readings in the last ${rangeLabel()}. Each panel keeps its own scale; one colour throughout, because every panel is a single series.`,
        }),
      ]),
    ])
  );
  host.appendChild(card);

  if (!rows.length) {
    card.appendChild(el('p', { class: 'empty', text: 'Nothing to plot in this window.' }));
    return;
  }

  const grid = el('div', { class: 'grid-multiples' });
  for (const { s, pts } of rows) {
    const stats = summarise(s, pts);
    const facet = el('button', {
      class: 'facet',
      title: `Open ${s.label}`,
      onclick: () => { state.selectedKey = s.key; state.view = 'detail'; render(); },
    }, [
      el('div', { class: 'facet-head' }, [
        el('span', { class: 'facet-label', text: s.label }),
        el('span', { class: 'facet-value', text: fmtValue(stats.last.v, s.unit) }),
      ]),
      sparkline(pts, { width: 220, height: 54, tail: 40 }),
      el('div', { class: 'facet-foot' }, [
        el('span', { text: `${stats.n} readings · ${fmtSpan(stats.spanDays)}` }),
        el('span', { class: `facet-trend trend-${stats.trend.direction}`, text: trendWord(stats.trend.direction) }),
      ]),
    ]);
    grid.appendChild(facet);
  }
  card.appendChild(grid);
}

/* ---------------- small pieces ---------------- */

function statTile(label, value, sub) {
  return el('div', { class: 'stat' }, [
    el('div', { class: 'stat-label', text: label }),
    el('div', { class: 'stat-value', text: value }),
    sub ? el('div', { class: 'stat-sub', text: sub }) : null,
  ]);
}

function trendHeadline(stats, unit) {
  const t = stats.trend;
  if (t.direction === 'unclear') return 'No clear trend';
  if (t.direction === 'flat') return 'Stable';
  const perYear = Math.abs(t.perYear);
  return `${t.direction === 'rising' ? 'Rising' : 'Falling'} ${fmtValue(perYear, unit)}/yr`;
}

function trendDetail(stats) {
  const t = stats.trend;
  if (t.reason) return t.reason;
  if (t.r2 != null) return `least-squares fit, R² ${t.r2.toFixed(2)}`;
  return null;
}

function trendWord(direction) {
  return { rising: 'Rising', falling: 'Falling', flat: 'Stable', unclear: 'Unclear' }[direction] || '';
}

function measureSubtitle(s, stats) {
  const bits = [];
  if (s.loinc) bits.push(`LOINC ${s.loinc}`);
  bits.push(categoryLabel(s.category));
  if (!stats.empty && stats.hasRange) bits.push(`reference ${rangeText(stats.range, s.unit)}`);
  return bits.join('  ·  ');
}

function chartFooter(s, stats, { allOutOfRange } = {}) {
  const notes = [];
  if (stats.hasRange) {
    notes.push(
      `Shaded band is the reference range reported with these observations (${rangeText(stats.range, s.unit)})` +
        (stats.range.varied
          ? '; the record reported more than one range for this measure, so the most frequent one is drawn.'
          : '.')
    );
    if (allOutOfRange) {
      const side = stats.lastStatus === 'low' ? 'below' : 'above';
      notes.push(
        `Every reading in this window sits ${side} that range, so no individual readings are flagged.`
      );
    } else {
      notes.push('Triangles mark readings outside it — pointing up for high, down for low.');
    }
    notes.push(
      'The vertical scale reaches toward the band but not all the way when the range is far from the data, ' +
        'so the shape of the trend stays readable; a band clipped at the plot edge continues beyond it.'
    );
  } else {
    notes.push(
      'No reference range accompanied these observations, so none is drawn and no in-range judgement is made.'
    );
  }
  return el('p', { class: 'footnote', text: notes.join(' ') });
}

function renderProvenance() {
  const bits = [
    `${state.meta.observations} Observation resources read from ${state.session.fhirBaseUrl}`,
    `${state.series.length} numeric series`,
  ];
  if (state.meta.nonNumeric) bits.push(`${state.meta.nonNumeric} non-numeric observations not plotted`);
  if (state.meta.skipped) bits.push(`${state.meta.skipped} without a usable date or code`);
  if (state.meta.truncated) bits.push(`paging stopped at ${CONFIG.data.maxPages} pages — older readings may be missing`);
  bits.push(`endpoints resolved via ${state.session.discoverySource}`);

  return el('footer', { class: 'provenance' }, [
    el('span', { text: bits.join('  ·  ') }),
  ]);
}

/* ---------------- formatting helpers ---------------- */

function rangeLabel() {
  return (TIME_RANGES.find((r) => r.id === state.rangeId) || {}).label?.toLowerCase() || 'window';
}

function categoryLabel(code) {
  return { 'vital-signs': 'Vital signs', laboratory: 'Laboratory', other: 'Other' }[code] || cap(code);
}

function cap(s) {
  return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
}

function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('');
}

function age(birthDate) {
  const b = new Date(birthDate);
  if (Number.isNaN(b.getTime())) return '';
  const now = new Date();
  let years = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) years -= 1;
  return `${years} y`;
}

function shortRef(ref) {
  const s = String(ref);
  const at = s.lastIndexOf('/', s.lastIndexOf('/') - 1);
  return at >= 0 ? s.slice(at + 1) : s;
}
