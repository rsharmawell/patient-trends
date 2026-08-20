/*
 * Observation → trend series.
 *
 * The one modelling rule worth stating up front: **reference ranges come only
 * from the data**. `Observation.referenceRange` is used when the server sends
 * it, and when it doesn't the series is shown without a band and without an
 * in-range judgement. The app never falls back to a built-in threshold table —
 * inventing a clinical cut-off that the record did not assert would make the
 * chart look authoritative about something it does not know.
 *
 * Same discipline on trends: a slope is only reported when the fit actually
 * explains the scatter (see R2_FLOOR). Otherwise the series is "no clear
 * direction", which is a real answer.
 */

import { CONFIG } from '../config.js';

const LOINC = 'http://loinc.org';

/** Least-squares fit has to explain this much variance before we call it a trend. */
const R2_FLOOR = 0.3;

/**
 * …and the fit has to be strong *for the number of points behind it*. With six
 * or seven readings, an R² of 0.35 turns up in pure noise often enough to be
 * worthless, so a variance floor alone would let the app announce a direction
 * that is not there. This is the F statistic for a simple linear regression,
 * R²/(1−R²)·(n−2); a threshold of 10 is roughly p < 0.01 at these sample sizes.
 */
const F_FLOOR = 10;

/** A trend also needs this much time on the x-axis to mean anything. */
const MIN_SPAN_DAYS = 90;

/* ------------------------------------------------------------------ *
 * Building series
 * ------------------------------------------------------------------ */

function observationDate(obs) {
  const raw =
    obs.effectiveDateTime ||
    obs.effectivePeriod?.start ||
    obs.effectiveInstant ||
    obs.issued;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

function codeKey(code) {
  const loinc = (code?.coding || []).find((c) => c.system === LOINC && c.code);
  if (loinc) return { key: `loinc:${loinc.code}`, loinc: loinc.code, label: loinc.display || code.text || loinc.code };
  const any = (code?.coding || []).find((c) => c.code);
  if (any) return { key: `${any.system || 'code'}|${any.code}`, loinc: null, label: any.display || code.text || any.code };
  if (code?.text) return { key: `text:${code.text.toLowerCase()}`, loinc: null, label: code.text };
  return null;
}

function categoryOf(obs) {
  for (const cat of obs.category || []) {
    for (const coding of cat.coding || []) {
      if (coding.code) return coding.code;
    }
    if (cat.text) return cat.text;
  }
  return 'other';
}

function rangeOf(node) {
  const rr = (node.referenceRange || [])[0];
  if (!rr) return { low: null, high: null, text: null };
  return {
    low: Number.isFinite(rr.low?.value) ? rr.low.value : null,
    high: Number.isFinite(rr.high?.value) ? rr.high.value : null,
    text: rr.text || null,
  };
}

function interpretationOf(node) {
  for (const interp of node.interpretation || []) {
    for (const coding of interp.coding || []) {
      if (coding.code) return coding.code; // H, L, N, HH, LL, A …
    }
    if (interp.text) return interp.text;
  }
  return null;
}

/**
 * Turn a flat list of Observations into named numeric series.
 *
 * A component-bearing Observation (blood pressure being the canonical case)
 * becomes one series per component, so systolic and diastolic are trended
 * independently rather than being collapsed into a single number.
 *
 * @returns {{series: Array, skipped: number, nonNumeric: number}}
 */
export function buildSeries(observations) {
  const byKey = new Map();
  let skipped = 0;
  let nonNumeric = 0;

  const push = (identity, obs, t, quantity, node) => {
    if (!Number.isFinite(quantity?.value)) return false;
    const unit = quantity.unit || quantity.code || '';
    // Unit is part of the identity: the same LOINC reported in two units is two
    // series, because plotting them on one axis would be wrong.
    const key = `${identity.key}#${unit}`;
    let series = byKey.get(key);
    if (!series) {
      series = {
        key,
        label: identity.label,
        loinc: identity.loinc,
        unit,
        category: categoryOf(obs),
        points: [],
      };
      byKey.set(key, series);
    }
    const range = rangeOf(node);
    series.points.push({
      t,
      v: quantity.value,
      obsId: obs.id || null,
      status: obs.status || null,
      refLow: range.low,
      refHigh: range.high,
      refText: range.text,
      interpretation: interpretationOf(node),
    });
    return true;
  };

  for (const obs of observations) {
    const t = observationDate(obs);
    if (t == null) {
      skipped += 1;
      continue;
    }

    if (Array.isArray(obs.component) && obs.component.length) {
      let any = false;
      for (const component of obs.component) {
        const identity = codeKey(component.code) || codeKey(obs.code);
        if (!identity) continue;
        // Component labels are usually terse ("Systolic"); keep them, but when
        // the component reuses the panel's own code, prefix the panel name so
        // two panels' components never collide in the rail.
        if (push(identity, obs, t, component.valueQuantity, component)) any = true;
      }
      if (!any) nonNumeric += 1;
      continue;
    }

    const identity = codeKey(obs.code);
    if (!identity) {
      skipped += 1;
      continue;
    }
    if (!push(identity, obs, t, obs.valueQuantity, obs)) nonNumeric += 1;
  }

  const series = [...byKey.values()];
  for (const s of series) {
    s.points.sort((a, b) => a.t - b.t);
    // Same instant twice is a duplicate feed, not two readings.
    s.points = dedupe(s.points);
  }

  // Vitals first, then labs, then everything else; alphabetical inside each.
  const order = { 'vital-signs': 0, laboratory: 1 };
  series.sort((a, b) => {
    const ca = order[a.category] ?? 2;
    const cb = order[b.category] ?? 2;
    if (ca !== cb) return ca - cb;
    return a.label.localeCompare(b.label);
  });

  return { series, skipped, nonNumeric };
}

function dedupe(points) {
  const out = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev && prev.t === p.t && prev.v === p.v) continue;
    out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Windowing
 * ------------------------------------------------------------------ */

export const TIME_RANGES = [
  { id: '1y', label: '1 year', days: 365 },
  { id: '3y', label: '3 years', days: 365 * 3 },
  { id: '5y', label: '5 years', days: 365 * 5 },
  { id: 'all', label: 'All', days: null },
];

/** Points inside the window, plus the window bounds actually used. */
export function windowPoints(series, rangeId, now = Date.now()) {
  const range = TIME_RANGES.find((r) => r.id === rangeId) || TIME_RANGES.at(-1);
  if (!range.days) return series.points;
  const cutoff = now - range.days * 86400000;
  return series.points.filter((p) => p.t >= cutoff);
}

/* ------------------------------------------------------------------ *
 * Statistics
 * ------------------------------------------------------------------ */

/**
 * Everything the UI needs to say about one series over one window.
 *
 * `trend` is deliberately conservative: `direction` is only 'rising' or
 * 'falling' when there are enough points, enough elapsed time, and enough
 * explained variance. Otherwise it is 'flat' (fit is good but slope is
 * negligible) or 'unclear'.
 */
export function summarise(series, points) {
  if (!points.length) {
    return { n: 0, empty: true, label: series.label, unit: series.unit };
  }

  const values = points.map((p) => p.v);
  const first = points[0];
  const last = points.at(-1);
  const min = Math.min(...values);
  const max = Math.max(...values);

  const range = effectiveRange(points);
  const flagged = points.map((p) => classify(p, range));
  const outOfRange = flagged.filter((f) => f !== 'in-range' && f !== 'unknown').length;
  const known = flagged.filter((f) => f !== 'unknown').length;

  const spanDays = (last.t - first.t) / 86400000;
  const fit = leastSquares(points);
  const trend = describeTrend({ fit, n: points.length, spanDays, values });

  return {
    empty: false,
    label: series.label,
    unit: series.unit,
    loinc: series.loinc,
    category: series.category,
    n: points.length,
    first,
    last,
    min,
    max,
    spanDays,
    range,
    hasRange: range.low != null || range.high != null,
    lastStatus: classify(last, range),
    outOfRange,
    inRangePct: known ? Math.round(((known - outOfRange) / known) * 100) : null,
    delta: last.v - first.v,
    deltaPct: first.v !== 0 ? ((last.v - first.v) / Math.abs(first.v)) * 100 : null,
    fit,
    trend,
  };
}

/**
 * The reference range to draw. Servers can vary the range per observation
 * (different analyser, different lab), so take the most frequently reported
 * pair rather than the newest — a single odd row should not move the band.
 */
function effectiveRange(points) {
  const counts = new Map();
  for (const p of points) {
    if (p.refLow == null && p.refHigh == null) continue;
    const key = `${p.refLow ?? ''}|${p.refHigh ?? ''}`;
    const entry = counts.get(key) || { low: p.refLow, high: p.refHigh, text: p.refText, n: 0 };
    entry.n += 1;
    counts.set(key, entry);
  }
  if (!counts.size) return { low: null, high: null, text: null, varied: false };
  const sorted = [...counts.values()].sort((a, b) => b.n - a.n);
  return { ...sorted[0], varied: counts.size > 1 };
}

/**
 * Where one point sits relative to the range.
 *
 * A server-supplied `interpretation` wins over our own comparison — the lab
 * knows things the numeric range does not (assay, sex- and age-specific cuts).
 */
export function classify(point, range) {
  const interp = point.interpretation;
  if (interp) {
    const code = String(interp).toUpperCase();
    if (code === 'HH' || code === 'H' || code === 'HU') return 'high';
    if (code === 'LL' || code === 'L' || code === 'LU') return 'low';
    if (code === 'N') return 'in-range';
  }
  const low = point.refLow ?? range?.low;
  const high = point.refHigh ?? range?.high;
  if (low == null && high == null) return 'unknown';
  if (high != null && point.v > high) return 'high';
  if (low != null && point.v < low) return 'low';
  return 'in-range';
}

/** Ordinary least squares over (days, value). */
function leastSquares(points) {
  const n = points.length;
  if (n < 2) return { slopePerDay: 0, intercept: points[0]?.v ?? 0, r2: 0 };

  const t0 = points[0].t;
  const xs = points.map((p) => (p.t - t0) / 86400000);
  const ys = points.map((p) => p.v);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0) return { slopePerDay: 0, intercept: my, r2: 0 };

  const slopePerDay = sxy / sxx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slopePerDay, intercept: my - slopePerDay * mx, r2, t0 };
}

function describeTrend({ fit, n, spanDays, values }) {
  if (n < CONFIG.data.minPointsForTrend) {
    return { direction: 'unclear', reason: `only ${n} reading${n === 1 ? '' : 's'} in this window` };
  }
  if (spanDays < MIN_SPAN_DAYS) {
    return { direction: 'unclear', reason: `readings span ${Math.round(spanDays)} days` };
  }
  if (fit.r2 < R2_FLOOR) {
    return {
      direction: 'unclear',
      reason: `readings vary too much for a direction (R² ${fit.r2.toFixed(2)})`,
      r2: fit.r2,
    };
  }
  const f = fit.r2 >= 1 ? Infinity : (fit.r2 / (1 - fit.r2)) * (n - 2);
  if (f < F_FLOOR) {
    return {
      direction: 'unclear',
      reason: `fit is not strong enough for ${n} readings (R² ${fit.r2.toFixed(2)})`,
      r2: fit.r2,
    };
  }

  const perYear = fit.slopePerDay * 365;
  const spread = Math.max(...values) - Math.min(...values);
  // "Negligible" is relative to the series' own spread, not an absolute number:
  // 0.1 means something for A1c and nothing for platelets.
  if (spread === 0 || Math.abs(perYear) < spread * 0.05) {
    return { direction: 'flat', perYear, r2: fit.r2, reason: 'stable across this window' };
  }
  return {
    direction: perYear > 0 ? 'rising' : 'falling',
    perYear,
    r2: fit.r2,
    reason: null,
  };
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

/** Precision that suits the magnitude, so 6.1 stays 6.1 and 128 stays 128. */
export function fmtValue(v, unit) {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 1 : 2;
  const text = v.toFixed(digits).replace(/\.0+$/, '');
  return unit ? `${text} ${unit}` : text;
}

export function fmtNumber(v, digits = 1) {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(digits).replace(/\.0+$/, '');
}

export function fmtSigned(v, unit) {
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${fmtValue(Math.abs(v), unit)}`;
}

export function fmtDate(t) {
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function fmtSpan(days) {
  if (!Number.isFinite(days)) return '—';
  if (days < 60) return `${Math.round(days)} days`;
  const months = days / 30.44;
  if (months < 24) return `${Math.round(months)} months`;
  return `${(days / 365.25).toFixed(1)} years`;
}

/** Percent change from the window's first reading, for the overlay view. */
export function indexToBaseline(points) {
  if (!points.length) return [];
  const base = points[0].v;
  if (!base) return points.map((p) => ({ ...p, indexed: 0 }));
  return points.map((p) => ({ ...p, indexed: ((p.v - base) / Math.abs(base)) * 100 }));
}
