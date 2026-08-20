/*
 * SVG charts.
 *
 * Two forms, both hand-built so the page carries no charting dependency:
 *
 *   sparkline()  — the 12-point trend inside a rail row. De-emphasised stroke,
 *                  current reading in the accent. No axes, no interaction.
 *   lineChart()  — the detail and overlay chart. Hairline solid grid, 2px line,
 *                  10% area wash on a single series, ≥8px end marker with a 2px
 *                  surface ring, reference band, crosshair tooltip, and a table
 *                  view twin so no value is gated behind hover.
 *
 * Colour comes from CSS custom properties, so light and dark are two selected
 * palettes rather than an automatic flip. The three categorical slots used by
 * the overlay were validated with the dataviz palette validator on the
 * all-pairs list in both modes; the overlay is capped at three series for that
 * reason — see MAX_OVERLAY.
 */

import { classify, fmtValue, fmtDate, fmtNumber } from './observations.js';

/** Overlay cap. Slots 1–3 clear the all-pairs CVD and normal-vision floors. */
export const MAX_OVERLAY = 3;

const SERIES_VARS = ['--series-1', '--series-2', '--series-3'];

export function seriesColorVar(index) {
  return SERIES_VARS[index % SERIES_VARS.length];
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    node.setAttribute(k, String(v));
  }
  return node;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v; // never innerHTML: labels are server data
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, String(v));
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** Axis ticks on clean numbers rather than on the data's own extremes. */
function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.001; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  return ticks.length ? ticks : [min, max];
}

/** Percent with a typographic minus, so axis and label agree with the prose. */
function signedPct(v, digits = 0) {
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '\u2212' : '';
  return `${sign}${Math.abs(v).toFixed(digits)}%`;
}

function dateTicks(t0, t1, count = 4) {
  if (!(t1 > t0)) return [t0];
  const out = [];
  for (let i = 0; i <= count; i++) out.push(t0 + ((t1 - t0) * i) / count);
  return out;
}

function shortDate(t) {
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
}

/* ------------------------------------------------------------------ *
 * Sparkline
 * ------------------------------------------------------------------ */

/**
 * A bare trend line for a rail row. Latest reading marked in the accent so the
 * eye lands on "now"; the rest of the line is de-emphasised.
 */
export function sparkline(points, { width = 116, height = 30, tail = 12 } = {}) {
  const node = svg('svg', {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    class: 'spark',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  const shown = points.slice(-tail);
  if (shown.length < 2) {
    if (shown.length === 1) {
      node.appendChild(svg('circle', { cx: width / 2, cy: height / 2, r: 3, class: 'spark-dot' }));
    }
    return node;
  }

  const pad = 4;
  const xs = shown.map((_, i) => pad + (i * (width - pad * 2)) / (shown.length - 1));
  const values = shown.map((p) => p.v);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const ys = values.map((v) => height - pad - ((v - lo) / span) * (height - pad * 2));

  node.appendChild(
    svg('path', {
      d: xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(' '),
      class: 'spark-line',
    })
  );
  node.appendChild(
    svg('circle', {
      cx: xs.at(-1).toFixed(1),
      cy: ys.at(-1).toFixed(1),
      r: 3,
      class: 'spark-dot',
    })
  );
  return node;
}

/* ------------------------------------------------------------------ *
 * Line chart
 * ------------------------------------------------------------------ */

/**
 * Render a line chart into `host`, re-rendering on resize.
 *
 * @param {HTMLElement} host
 * @param {object} spec
 * @param {Array<{key,label,points,unit,colorVar}>} spec.series  1..MAX_OVERLAY
 * @param {'value'|'indexed'} spec.mode  raw values, or % change from baseline
 * @param {{low,high,text}|null} spec.band  reference range, only when the data supplied one
 * @param {string} spec.yLabel
 */
export function lineChart(host, spec) {
  host.textContent = '';
  const frame = el('div', { class: 'chart-frame' });
  host.appendChild(frame);

  const draw = () => {
    const width = Math.max(frame.clientWidth || host.clientWidth || 640, 280);
    frame.textContent = '';
    frame.appendChild(renderLineChart(width, spec));
  };

  draw();

  // ResizeObserver rather than a window listener: the rail can collapse and
  // change the plot width without the window changing size at all.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => draw());
    ro.observe(frame);
    host._chartObserver?.disconnect();
    host._chartObserver = ro;
  }
}

function renderLineChart(width, spec) {
  const { series, mode = 'value', band = null, yLabel = '', flagPoints = true } = spec;
  const HEIGHT = 300;
  const M = { top: 18, right: 68, bottom: 34, left: 56 }; // right leaves room for end labels
  const plotW = width - M.left - M.right;
  const plotH = HEIGHT - M.top - M.bottom;

  const wrap = el('div', { class: 'chart' });

  const valued = series.map((s) => ({
    ...s,
    pts: s.points.map((p) => ({ ...p, y: mode === 'indexed' ? p.indexed : p.v })),
  }));
  const all = valued.flatMap((s) => s.pts);
  if (!all.length) {
    wrap.appendChild(el('p', { class: 'empty', text: 'No readings in this window.' }));
    return wrap;
  }

  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t));
  const dataLo = Math.min(...all.map((p) => p.y));
  const dataHi = Math.max(...all.map((p) => p.y));
  let lo = dataLo;
  let hi = dataHi;

  // The band belongs in the picture, but only so far. A reference range far
  // from the data — an A1c of 7–8 against a 4–6 range — would otherwise
  // compress every reading into a strip at the top of the plot and destroy the
  // shape the chart exists to show. So the scale reaches toward the band by at
  // most half the data's own spread; beyond that the band is clipped by the
  // plot edge, which reads correctly as "the range continues past here".
  if (mode === 'value' && band) {
    const spread = dataHi - dataLo || Math.abs(dataHi) * 0.1 || 1;
    if (band.low != null) lo = Math.min(lo, Math.max(band.low, dataLo - spread * 0.5));
    if (band.high != null) hi = Math.max(hi, Math.min(band.high, dataHi + spread * 0.5));
  }
  if (mode === 'indexed') {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  const padY = (hi - lo) * 0.12 || Math.abs(hi) * 0.12 || 1;
  lo -= padY;
  hi += padY;

  const x = (t) => (t1 === t0 ? M.left + plotW / 2 : M.left + ((t - t0) / (t1 - t0)) * plotW);
  const y = (v) => M.top + plotH - ((v - lo) / (hi - lo)) * plotH;

  const root = svg('svg', {
    width,
    height: HEIGHT,
    viewBox: `0 0 ${width} ${HEIGHT}`,
    class: 'plot',
    role: 'img',
    'aria-label': `${yLabel || 'Trend'} over time, ${all.length} readings`,
  });

  /* ---- reference band: neutral wash, never a categorical hue ---- */
  const clampY = (v) => Math.min(Math.max(v, M.top), M.top + plotH);
  const bandDrawn = mode === 'value' && band && (band.low != null || band.high != null);
  if (bandDrawn) {
    const top = clampY(band.high != null ? y(band.high) : M.top);
    const bottom = clampY(band.low != null ? y(band.low) : M.top + plotH);
    root.appendChild(
      svg('rect', {
        x: M.left,
        y: Math.min(top, bottom),
        width: plotW,
        height: Math.max(Math.abs(bottom - top), 1),
        class: 'band',
      })
    );
    // Only draw an edge that is actually inside the plot; an edge pinned to the
    // frame would read as a threshold the data crosses when it does not.
    for (const edge of [band.low, band.high]) {
      if (edge == null) continue;
      const yy = y(edge);
      if (yy < M.top || yy > M.top + plotH) continue;
      root.appendChild(
        svg('line', { x1: M.left, x2: M.left + plotW, y1: yy, y2: yy, class: 'band-edge' })
      );
    }

    // Name the band in the plot, but only when the text fits inside it with
    // room to spare — a clipped label is worse than none.
    const height = Math.abs(bottom - top);
    if (height >= 20) {
      const label = svg('text', {
        x: M.left + plotW - 6,
        y: Math.min(top, bottom) + height / 2 + 3.5,
        class: 'band-label',
      });
      label.textContent = 'reference range';
      root.appendChild(label);
    }
  }

  /* ---- gridlines + y ticks: hairline, solid, recessive ---- */
  const yTicks = niceTicks(lo, hi, 5);
  for (const tick of yTicks) {
    const yy = y(tick);
    if (yy < M.top - 1 || yy > M.top + plotH + 1) continue;
    root.appendChild(
      svg('line', { x1: M.left, x2: M.left + plotW, y1: yy, y2: yy, class: 'grid' })
    );
    const label = svg('text', { x: M.left - 8, y: yy + 3.5, class: 'tick tick-y' });
    label.textContent = mode === 'indexed' ? signedPct(tick) : fmtNumber(tick, tickDigits(yTicks));
    root.appendChild(label);
  }

  // Zero line for the indexed view — the baseline everything is measured from.
  if (mode === 'indexed' && lo < 0 && hi > 0) {
    root.appendChild(
      svg('line', { x1: M.left, x2: M.left + plotW, y1: y(0), y2: y(0), class: 'axis' })
    );
  }

  /* ---- x axis ---- */
  root.appendChild(
    svg('line', {
      x1: M.left,
      x2: M.left + plotW,
      y1: M.top + plotH,
      y2: M.top + plotH,
      class: 'axis',
    })
  );
  for (const t of dateTicks(t0, t1, Math.max(2, Math.min(5, Math.floor(plotW / 90))))) {
    const label = svg('text', { x: x(t), y: M.top + plotH + 18, class: 'tick tick-x' });
    label.textContent = shortDate(t);
    root.appendChild(label);
  }

  /* ---- series ---- */
  valued.forEach((s, i) => {
    const colorVar = s.colorVar || seriesColorVar(i);
    const stroke = `var(${colorVar})`;

    // Area wash only for a lone series, and never underneath a reference band:
    // two overlapping washes stop reading as either one.
    if (valued.length === 1 && !bandDrawn && s.pts.length > 1) {
      const areaBase = mode === 'indexed' ? y(0) : M.top + plotH;
      const d =
        `M${x(s.pts[0].t)} ${areaBase} ` +
        s.pts.map((p) => `L${x(p.t).toFixed(1)} ${y(p.y).toFixed(1)}`).join(' ') +
        ` L${x(s.pts.at(-1).t)} ${areaBase} Z`;
      root.appendChild(svg('path', { d, fill: stroke, class: 'area' }));
    }

    if (s.pts.length > 1) {
      root.appendChild(
        svg('path', {
          d: s.pts.map((p, j) => `${j ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.y).toFixed(1)}`).join(' '),
          class: 'line',
          stroke,
        })
      );
    }

    // Out-of-range markers: a triangle pointing the way the value went, in the
    // status colour. Shape carries direction so the flag is never colour-alone.
    // `flagPoints` is false when every reading in the window is out of range —
    // a flag on all of them marks nothing, and the band position plus the
    // "within reference range" tile already say it.
    if (mode === 'value' && flagPoints) {
      for (const p of s.pts) {
        const status = classify(p, band);
        if (status !== 'high' && status !== 'low') continue;
        root.appendChild(
          svg('path', {
            d: trianglePath(x(p.t), y(p.y), 4.5, status === 'high' ? -1 : 1),
            class: `flag flag-${status}`,
          })
        );
      }
    }

    // End marker: ≥8px diameter, 2px surface ring so it stays legible on the line.
    const last = s.pts.at(-1);
    root.appendChild(
      svg('circle', { cx: x(last.t), cy: y(last.y), r: 4.5, class: 'end-dot', fill: stroke })
    );

    // Direct end-label. Sparing by design: the latest value only, never a
    // number on every point.
    const label = svg('text', {
      x: Math.min(x(last.t) + 10, width - 4),
      y: y(last.y) + 4,
      class: 'end-label',
    });
    label.textContent = mode === 'indexed' ? signedPct(last.indexed) : fmtValue(last.v, '');
    root.appendChild(label);
  });

  /* ---- crosshair + tooltip ---- */
  const crosshair = svg('line', {
    x1: 0, x2: 0, y1: M.top, y2: M.top + plotH, class: 'crosshair hidden',
  });
  root.appendChild(crosshair);
  const hoverDots = svg('g', {});
  root.appendChild(hoverDots);

  const hit = svg('rect', {
    x: M.left, y: M.top, width: plotW, height: plotH, class: 'hit', tabindex: '0',
    role: 'application',
    'aria-label': 'Chart. Use left and right arrow keys to step through readings.',
  });
  root.appendChild(hit);
  wrap.appendChild(root);

  const tip = el('div', { class: 'tip hidden', role: 'status' });
  wrap.appendChild(tip);

  // Snap to a date, not to a line: the reader aims at an x position and gets
  // every series' value there.
  const times = [...new Set(all.map((p) => p.t))].sort((a, b) => a - b);
  let cursor = times.length - 1;

  const showAt = (t) => {
    crosshair.classList.remove('hidden');
    crosshair.setAttribute('x1', x(t));
    crosshair.setAttribute('x2', x(t));
    hoverDots.textContent = '';

    const rows = [];
    for (const [i, s] of valued.entries()) {
      const p = nearest(s.pts, t);
      if (!p) continue;
      const colorVar = s.colorVar || seriesColorVar(i);
      hoverDots.appendChild(
        svg('circle', {
          cx: x(p.t), cy: y(p.y), r: 4.5, class: 'hover-dot', fill: `var(${colorVar})`,
        })
      );
      rows.push({ s, p, colorVar, status: mode === 'value' ? classify(p, band) : null });
    }
    if (!rows.length) return;

    tip.textContent = '';
    tip.appendChild(el('div', { class: 'tip-date', text: fmtDate(rows[0].p.t) }));
    for (const row of rows) {
      const line = el('div', { class: 'tip-row' });
      const key = el('span', { class: 'tip-key' });
      key.style.background = `var(${row.colorVar})`;
      line.appendChild(key);
      line.appendChild(
        el('span', {
          class: 'tip-value',
          text: mode === 'indexed' ? signedPct(row.p.indexed, 1) : fmtValue(row.p.v, row.s.unit),
        })
      );
      line.appendChild(el('span', { class: 'tip-label', text: row.s.label }));
      if (row.status === 'high' || row.status === 'low') {
        line.appendChild(el('span', { class: `tip-flag tip-flag-${row.status}`, text: row.status === 'high' ? 'High' : 'Low' }));
      }
      tip.appendChild(line);
    }
    tip.classList.remove('hidden');

    const px = x(rows[0].p.t);
    const flip = px > M.left + plotW * 0.6;
    tip.style.left = `${flip ? px - 14 : px + 14}px`;
    tip.style.transform = flip ? 'translateX(-100%)' : 'none';
    tip.style.top = `${M.top + 4}px`;
  };

  const hide = () => {
    crosshair.classList.add('hidden');
    tip.classList.add('hidden');
    hoverDots.textContent = '';
  };

  const timeAtPointer = (evt) => {
    const box = root.getBoundingClientRect();
    const px = ((evt.clientX - box.left) / box.width) * width;
    const ratio = Math.min(Math.max((px - M.left) / plotW, 0), 1);
    const t = t0 + ratio * (t1 - t0);
    let best = times[0];
    for (const candidate of times) {
      if (Math.abs(candidate - t) < Math.abs(best - t)) best = candidate;
    }
    cursor = times.indexOf(best);
    return best;
  };

  hit.addEventListener('pointermove', (evt) => showAt(timeAtPointer(evt)));
  hit.addEventListener('pointerdown', (evt) => showAt(timeAtPointer(evt)));
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('focus', () => showAt(times[cursor]));
  hit.addEventListener('blur', hide);
  hit.addEventListener('keydown', (evt) => {
    if (evt.key === 'ArrowRight') cursor = Math.min(cursor + 1, times.length - 1);
    else if (evt.key === 'ArrowLeft') cursor = Math.max(cursor - 1, 0);
    else if (evt.key === 'Home') cursor = 0;
    else if (evt.key === 'End') cursor = times.length - 1;
    else if (evt.key === 'Escape') { hide(); return; }
    else return;
    evt.preventDefault();
    showAt(times[cursor]);
  });

  return wrap;
}

function tickDigits(ticks) {
  const step = Math.abs((ticks[1] ?? ticks[0]) - ticks[0]);
  if (!Number.isFinite(step) || step === 0) return 1;
  if (step >= 10) return 0;
  if (step >= 1) return 0;
  if (step >= 0.1) return 1;
  return 2;
}

function trianglePath(cx, cy, r, dir) {
  // dir -1 → apex up (high), +1 → apex down (low)
  const top = cy + dir * -r;
  const base = cy + dir * r * 0.7;
  return `M${cx} ${top} L${cx + r} ${base} L${cx - r} ${base} Z`;
}

function nearest(points, t) {
  if (!points.length) return null;
  let best = points[0];
  for (const p of points) {
    if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Table view — the twin that keeps every value reachable without hover
 * ------------------------------------------------------------------ */

export function valueTable(series, { mode = 'value', band = null } = {}) {
  const multi = series.length > 1;
  const rows = [];

  if (multi) {
    const times = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => b - a);
    for (const t of times) {
      const cells = [fmtDate(t)];
      for (const s of series) {
        const p = s.points.find((q) => q.t === t);
        cells.push(
          !p
            ? '—'
            : mode === 'indexed'
              ? signedPct(p.indexed, 1)
              : fmtValue(p.v, s.unit)
        );
      }
      rows.push(cells);
    }
    return buildTable(['Date', ...series.map((s) => s.label)], rows);
  }

  const s = series[0];
  for (const p of [...s.points].reverse()) {
    const status = classify(p, band);
    rows.push([
      fmtDate(p.t),
      fmtValue(p.v, s.unit),
      statusWord(status),
      p.refLow != null || p.refHigh != null
        ? rangeText({ low: p.refLow, high: p.refHigh, text: p.refText }, s.unit)
        : band && (band.low != null || band.high != null)
          ? rangeText(band, s.unit)
          : 'not supplied',
    ]);
  }
  return buildTable(['Date', 'Value', 'Flag', 'Reference range'], rows);
}

export function statusWord(status) {
  if (status === 'high') return 'High';
  if (status === 'low') return 'Low';
  if (status === 'in-range') return 'In range';
  return '—';
}

export function rangeText(band, unit) {
  if (!band) return 'not supplied';
  if (band.text) return band.text;
  if (band.low != null && band.high != null) return `${fmtNumber(band.low, 2)}–${fmtNumber(band.high, 2)}${unit ? ' ' + unit : ''}`;
  if (band.high != null) return `≤ ${fmtNumber(band.high, 2)}${unit ? ' ' + unit : ''}`;
  if (band.low != null) return `≥ ${fmtNumber(band.low, 2)}${unit ? ' ' + unit : ''}`;
  return 'not supplied';
}

function buildTable(columns, rows) {
  const wrap = el('div', { class: 'tablewrap' });
  const table = el('table', { class: 'values' });
  table.appendChild(el('thead', {}, el('tr', {}, columns.map((c) => el('th', { text: c })))));
  table.appendChild(
    el(
      'tbody',
      {},
      rows.map((r) =>
        el(
          'tr',
          {},
          r.map((cell, i) => el('td', { class: i === 0 ? '' : 'num', text: String(cell) }))
        )
      )
    )
  );
  wrap.appendChild(table);
  return wrap;
}

export { el };
