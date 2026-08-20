#!/usr/bin/env node
/*
 * Mock EMR + FHIR gateway + authorization server, for running the viewer
 * without oscar-next-fhir, Keycloak or WELL ID.
 *
 * It gives you the three things an EHR launch needs:
 *   /                     a stand-in EMR chart page with a "Launch" button
 *   /fhir/r4/…            FHIR R4 reads, SMART scope enforcement, discovery
 *   /oauth/authorize|token  authorization-code + PKCE, launch-context redemption
 *
 * The seeded record is five years of longitudinal observations for one patient,
 * deterministic across runs (a fixed LCG, no Math.random), so screenshots and
 * assertions are stable.
 *
 *   node test/mock-ehr.mjs [port]      # default 8099
 *
 * Flags:
 *   MOCK_HIDE_DISCOVERY=1   omit {base}/.well-known/smart-configuration and the
 *                           oauth-uris extension, reproducing the Polaris
 *                           gateway's discovery gap so the pinned fallback runs
 *   MOCK_NO_REFRESH=1       issue no refresh token
 *   MOCK_SHORT_TOKEN=<sec>  short access-token lifetime, to watch silent refresh
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] || 8099);
const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const ORIGIN = () => `http://localhost:${PORT}`;
const FHIR_BASE = () => `${ORIGIN()}/fhir/r4`;

const HIDE_DISCOVERY = process.env.MOCK_HIDE_DISCOVERY === '1';
const NO_REFRESH = process.env.MOCK_NO_REFRESH === '1';
const TOKEN_TTL = Number(process.env.MOCK_SHORT_TOKEN || 3600);

/* ------------------------------------------------------------------ *
 * Deterministic pseudo-randomness
 * ------------------------------------------------------------------ */

let seed = 20260820;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
/** Normal-ish noise via the mean of three uniforms. */
function jitter(scale) {
  return ((rnd() + rnd() + rnd()) / 3 - 0.5) * 2 * scale;
}

/* ------------------------------------------------------------------ *
 * Seed record
 * ------------------------------------------------------------------ */

const PATIENT_ID = '10001';
const NOW = Date.parse('2026-08-20T09:00:00-04:00');
const DAY = 86400000;

const patient = {
  resourceType: 'Patient',
  id: PATIENT_ID,
  identifier: [
    { system: 'http://services.well.com/fhir/demographic-no', value: PATIENT_ID, type: { text: 'MRN' } },
  ],
  name: [{ use: 'official', family: 'Okonkwo', given: ['Adaeze'] }],
  gender: 'female',
  birthDate: '1974-03-02',
  telecom: [{ system: 'phone', value: '416-555-0142', use: 'home' }],
  address: [{ city: 'Toronto', state: 'ON', postalCode: 'M6J 1H4', country: 'CA' }],
};

const conditions = [
  {
    resourceType: 'Condition', id: 'c1',
    clinicalStatus: { coding: [{ code: 'active' }], text: 'active' },
    verificationStatus: { text: 'confirmed' },
    code: { text: 'Type 2 diabetes mellitus', coding: [{ system: 'http://snomed.info/sct', code: '44054006', display: 'Type 2 diabetes mellitus' }] },
    onsetDateTime: '2019-04-11',
    subject: { reference: `Patient/${PATIENT_ID}` },
  },
  {
    resourceType: 'Condition', id: 'c2',
    clinicalStatus: { coding: [{ code: 'active' }], text: 'active' },
    verificationStatus: { text: 'confirmed' },
    code: { text: 'Essential hypertension', coding: [{ system: 'http://snomed.info/sct', code: '59621000', display: 'Essential hypertension' }] },
    onsetDateTime: '2017-01-23',
    subject: { reference: `Patient/${PATIENT_ID}` },
  },
  {
    resourceType: 'Condition', id: 'c3',
    clinicalStatus: { coding: [{ code: 'active' }], text: 'active' },
    code: { text: 'Chronic kidney disease, stage 2' },
    onsetDateTime: '2023-06-02',
    subject: { reference: `Patient/${PATIENT_ID}` },
  },
];

/**
 * Series definitions. `shape(yearsAgo)` returns the value; the intent is a
 * record that rewards trending — A1c climbing then falling after therapy
 * intensifies, LDL responding to a statin, weight drifting down, eGFR slipping.
 */
const SERIES_SPECS = [
  {
    loinc: '4548-4', display: 'Hemoglobin A1c/Hemoglobin.total in Blood',
    unit: '%', category: 'laboratory', every: 91, span: 5,
    ref: { low: 4.0, high: 6.0 },
    shape: (a) => (a > 2.2 ? 7.9 - (5 - a) * 0.18 : 7.55 - (2.2 - a) * 0.42) + jitter(0.18),
  },
  {
    loinc: '13457-7', display: 'LDL Cholesterol (calculated)',
    unit: 'mmol/L', category: 'laboratory', every: 182, span: 5,
    ref: { low: 0, high: 2.0 },
    shape: (a) => (a > 1.6 ? 3.6 - (5 - a) * 0.06 : 2.35 - (1.6 - a) * 0.45) + jitter(0.14),
  },
  {
    loinc: '2160-0', display: 'Creatinine [Moles/volume] in Serum or Plasma',
    unit: 'umol/L', category: 'laboratory', every: 91, span: 5,
    ref: { low: 45, high: 84 },
    shape: (a) => 70 + (5 - a) * 3.4 + jitter(5),
  },
  {
    loinc: '33914-3', display: 'Estimated glomerular filtration rate',
    unit: 'mL/min/1.73m2', category: 'laboratory', every: 91, span: 5,
    ref: { low: 60, high: 120 },
    shape: (a) => 88 - (5 - a) * 2.6 + jitter(3.5),
  },
  {
    loinc: '718-7', display: 'Hemoglobin [Mass/volume] in Blood',
    unit: 'g/L', category: 'laboratory', every: 182, span: 5,
    ref: { low: 120, high: 160 },
    shape: () => 133 + jitter(7),
  },
  {
    loinc: '2951-2', display: 'Sodium [Moles/volume] in Serum or Plasma',
    unit: 'mmol/L', category: 'laboratory', every: 182, span: 5,
    ref: { low: 135, high: 145 },
    shape: () => 139 + jitter(2.2),
  },
  {
    loinc: '8867-4', display: 'Heart rate',
    unit: 'beats/min', category: 'vital-signs', every: 61, span: 5,
    ref: { low: 60, high: 100 },
    shape: () => 74 + jitter(9),
  },
  {
    // Deliberately no reference range: exercises the "not supplied" path, where
    // the app draws no band and makes no in-range claim.
    loinc: '29463-7', display: 'Body weight',
    unit: 'kg', category: 'vital-signs', every: 61, span: 5,
    ref: null,
    shape: (a) => 74.5 - (5 - a) * 1.25 + jitter(0.7),
  },
  {
    loinc: '39156-5', display: 'Body mass index',
    unit: 'kg/m2', category: 'vital-signs', every: 61, span: 5,
    ref: { low: 18.5, high: 24.9 },
    shape: (a) => 27.4 - (5 - a) * 0.46 + jitter(0.26),
  },
];

/** Blood pressure: one Observation with two components, so it becomes two series. */
const BP_SPEC = {
  every: 61, span: 5,
  systolic: (a) => (a > 1.4 ? 147 - (5 - a) * 1.1 : 141 - (1.4 - a) * 7.5) + jitter(6),
  diastolic: (a) => (a > 1.4 ? 93 - (5 - a) * 0.6 : 90 - (1.4 - a) * 4.5) + jitter(4),
};

function isoDate(t) {
  return new Date(t).toISOString().slice(0, 10);
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function digitsFor(unit) {
  if (unit === '%' || unit === 'mmol/L' || unit === 'kg' || unit === 'kg/m2') return 1;
  return 0;
}

function buildObservations() {
  const out = [];
  let n = 0;

  for (const spec of SERIES_SPECS) {
    const count = Math.floor((spec.span * 365) / spec.every);
    for (let i = count; i >= 0; i--) {
      const t = NOW - i * spec.every * DAY - Math.floor(rnd() * 4) * DAY;
      const yearsAgo = (NOW - t) / (365 * DAY);
      const value = round(spec.shape(yearsAgo), digitsFor(spec.unit));
      const obs = {
        resourceType: 'Observation',
        id: `obs-${++n}`,
        status: 'final',
        category: [{
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: spec.category }],
        }],
        code: {
          coding: [{ system: 'http://loinc.org', code: spec.loinc, display: spec.display }],
          text: spec.display,
        },
        subject: { reference: `Patient/${PATIENT_ID}` },
        effectiveDateTime: isoDate(t),
        issued: new Date(t).toISOString(),
        valueQuantity: { value, unit: spec.unit, system: 'http://unitsofmeasure.org', code: spec.unit },
      };
      if (spec.ref) {
        obs.referenceRange = [{
          low: { value: spec.ref.low, unit: spec.unit },
          high: { value: spec.ref.high, unit: spec.unit },
        }];
        if (value > spec.ref.high) obs.interpretation = [{ coding: [{ code: 'H', display: 'High' }] }];
        else if (value < spec.ref.low) obs.interpretation = [{ coding: [{ code: 'L', display: 'Low' }] }];
      }
      out.push(obs);
    }
  }

  const bpCount = Math.floor((BP_SPEC.span * 365) / BP_SPEC.every);
  for (let i = bpCount; i >= 0; i--) {
    const t = NOW - i * BP_SPEC.every * DAY - Math.floor(rnd() * 3) * DAY;
    const yearsAgo = (NOW - t) / (365 * DAY);
    const sys = Math.round(BP_SPEC.systolic(yearsAgo));
    const dia = Math.round(BP_SPEC.diastolic(yearsAgo));
    out.push({
      resourceType: 'Observation',
      id: `obs-bp-${bpCount - i + 1}`,
      status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
      code: {
        coding: [{ system: 'http://loinc.org', code: '85354-9', display: 'Blood pressure panel' }],
        text: 'Blood pressure panel',
      },
      subject: { reference: `Patient/${PATIENT_ID}` },
      effectiveDateTime: isoDate(t),
      component: [
        {
          code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic blood pressure' }] },
          valueQuantity: { value: sys, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' },
          referenceRange: [{ low: { value: 90, unit: 'mmHg' }, high: { value: 130, unit: 'mmHg' } }],
          ...(sys > 130 ? { interpretation: [{ coding: [{ code: 'H' }] }] } : {}),
        },
        {
          code: { coding: [{ system: 'http://loinc.org', code: '8462-4', display: 'Diastolic blood pressure' }] },
          valueQuantity: { value: dia, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' },
          referenceRange: [{ low: { value: 60, unit: 'mmHg' }, high: { value: 80, unit: 'mmHg' } }],
          ...(dia > 80 ? { interpretation: [{ coding: [{ code: 'H' }] }] } : {}),
        },
      ],
    });
  }

  // A non-numeric observation, so the "not plotted" counter is exercised.
  out.push({
    resourceType: 'Observation',
    id: 'obs-smoking',
    status: 'final',
    category: [{ coding: [{ code: 'laboratory' }] }],
    code: { coding: [{ system: 'http://loinc.org', code: '72166-2', display: 'Tobacco smoking status' }], text: 'Tobacco smoking status' },
    subject: { reference: `Patient/${PATIENT_ID}` },
    effectiveDateTime: '2026-06-12',
    valueCodeableConcept: { text: 'Never smoker' },
  });

  out.sort((a, b) => Date.parse(a.effectiveDateTime) - Date.parse(b.effectiveDateTime));
  return out;
}

const OBSERVATIONS = buildObservations();

/* ------------------------------------------------------------------ *
 * SMART metadata
 * ------------------------------------------------------------------ */

const PATIENT_COMPARTMENT = [
  'AllergyIntolerance', 'Appointment', 'Condition', 'DiagnosticReport',
  'DocumentReference', 'Immunization', 'MedicationRequest',
  'MedicationStatement', 'Observation', 'Patient',
];
const ALL_RESOURCES = [...PATIENT_COMPARTMENT, 'Location', 'Practitioner'];

const smartConfiguration = () => ({
  issuer: `${ORIGIN()}/oauth`,
  authorization_endpoint: `${ORIGIN()}/oauth/authorize`,
  token_endpoint: `${ORIGIN()}/oauth/token`,
  introspection_endpoint: `${ORIGIN()}/oauth/introspect`,
  revocation_endpoint: `${ORIGIN()}/oauth/revoke`,
  scopes_supported: [
    'openid', 'profile', 'fhirUser', 'launch', 'launch/patient',
    'online_access', 'offline_access',
    ...ALL_RESOURCES.flatMap((r) => [`user/${r}.read`, `user/${r}.write`]),
    ...PATIENT_COMPARTMENT.map((r) => `patient/${r}.read`),
  ],
  capabilities: [
    'launch-ehr', 'launch-standalone', 'client-public',
    'context-ehr-patient', 'context-standalone-patient',
    'permission-patient', 'permission-user', 'permission-online',
  ],
  token_endpoint_auth_methods_supported: ['none'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
});

const capabilityStatement = () => {
  const doc = {
    resourceType: 'CapabilityStatement',
    status: 'active',
    date: '2026-08-20',
    publisher: 'WELL Health Technologies Corp',
    kind: 'instance',
    software: { name: 'mock polaris fhir gateway', version: '0.0.0' },
    fhirVersion: '4.0.1',
    format: ['application/fhir+json'],
    rest: [{
      mode: 'server',
      resource: ALL_RESOURCES.map((t) => ({
        type: t, interaction: [{ code: 'read' }, { code: 'search-type' }],
      })),
    }],
  };
  if (!HIDE_DISCOVERY) {
    doc.rest[0].security = {
      service: [{
        text: 'OAuth2 using SMART-on-FHIR profile',
        coding: [{ system: 'http://hl7.org/fhir/restful-security-service', code: 'SMART-on-FHIR' }],
      }],
      extension: [{
        url: 'http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris',
        extension: [
          { url: 'authorize', valueUri: `${ORIGIN()}/oauth/authorize` },
          { url: 'token', valueUri: `${ORIGIN()}/oauth/token` },
        ],
      }],
    };
  }
  return doc;
};

/* ------------------------------------------------------------------ *
 * Authorization server
 * ------------------------------------------------------------------ */

const launchContexts = new Map(); // launch id → patient id
const authCodes = new Map();
const refreshTokens = new Map();

// A couple of pre-minted launch contexts so the EMR page can link straight in.
launchContexts.set('ctx-adaeze-okonkwo', PATIENT_ID);

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function mintAccessToken(scope, patientId) {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url({ alg: 'RS256', typ: 'JWT', kid: 'mock-1' }),
    b64url({
      iss: `${ORIGIN()}/oauth`,
      sub: 'provider|999',
      aud: FHIR_BASE(),
      iat: now,
      exp: now + TOKEN_TTL,
      scope,
      patient: patientId,
      fhirUser: `${FHIR_BASE()}/Practitioner/p1`,
      provider_no: '999',
      emr_tenant: 'mock-clinic-01',
    }),
    'bW9jay1zaWduYXR1cmU',
  ].join('.');
}

function mintIdToken(nonce) {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url({ alg: 'RS256', typ: 'JWT', kid: 'mock-1' }),
    b64url({
      iss: `${ORIGIN()}/oauth`,
      sub: 'provider|999',
      aud: 'polaris-patient-trends',
      iat: now,
      exp: now + TOKEN_TTL,
      nonce,
      fhirUser: `${FHIR_BASE()}/Practitioner/p1`,
      name: 'Dr. R. Sharma',
    }),
    'bW9jay1zaWduYXR1cmU',
  ].join('.');
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

function sendJson(res, status, body, contentType = 'application/fhir+json; charset=utf-8') {
  cors(res);
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(JSON.stringify(body, null, 2));
}

function outcome(res, status, diagnostics) {
  sendJson(res, status, {
    resourceType: 'OperationOutcome',
    issue: [{ severity: 'error', code: status === 403 ? 'forbidden' : 'processing', diagnostics }],
  });
}

function scopesFrom(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const parts = auth.slice(7).split('.');
  if (parts.length < 2) return [];
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (Number.isFinite(claims.exp) && claims.exp * 1000 < Date.now()) return 'expired';
    return String(claims.scope || '').split(/\s+/).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function scopeAllows(scopes, resourceType) {
  return scopes.some((s) =>
    s === `patient/${resourceType}.read` || s === 'patient/*.read' ||
    s === `user/${resourceType}.read` || s === 'user/*.read' ||
    s === `system/${resourceType}.read` || s === 'system/*.read'
  );
}

const EMR_PAGE = () => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mock EMR — chart</title>
<link rel="stylesheet" href="/styles.css">
<style>
  body { background: var(--plane); }
  .emr { max-width: 760px; margin: 0 auto; padding: 48px 24px; }
  .emr-chart { background: var(--surface-1); border: 1px solid var(--hairline); border-radius: 12px; padding: 26px 28px; }
  .emr h1 { font-size: 20px; margin-bottom: 4px; }
  .emr-sub { color: var(--muted); font-size: 13px; margin: 0 0 22px; }
  .emr-row { display: flex; gap: 26px; flex-wrap: wrap; margin-bottom: 24px; font-size: 13px; color: var(--ink-2); }
  .emr-apps { border-top: 1px solid var(--hairline); padding-top: 20px; }
  .emr-apps h2 { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-bottom: 12px; }
  .emr-app { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; }
  .emr-app-name { font-size: 14px; font-weight: 550; }
  .emr-app-desc { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .emr-note { margin-top: 26px; font-size: 12px; color: var(--muted); line-height: 1.6; }
  code { font-family: var(--mono); font-size: 11.5px; background: var(--wash); padding: 1px 5px; border-radius: 4px; }
</style></head><body>
<div class="emr"><div class="emr-chart">
  <h1>Adaeze Okonkwo</h1>
  <p class="emr-sub">Female · 1974-03-02 · MRN 10001</p>
  <div class="emr-row">
    <span>T2DM · Hypertension · CKD stage 2</span>
    <span>Last visit 2026-06-12</span>
  </div>
  <div class="emr-apps">
    <h2>SMART apps</h2>
    <div class="emr-app">
      <div>
        <div class="emr-app-name">Patient Trends</div>
        <div class="emr-app-desc">Longitudinal results and vitals with reference ranges</div>
      </div>
      <a class="btn btn-primary" style="text-decoration:none"
         href="/launch.html?iss=${encodeURIComponent(FHIR_BASE())}&launch=ctx-adaeze-okonkwo">Launch</a>
    </div>
  </div>
  <p class="emr-note">
    This page stands in for the EMR. The Launch button opens
    <code>launch.html?iss=…&amp;launch=…</code>, which is the only entry point the
    app has. Discovery is ${HIDE_DISCOVERY ? '<strong>hidden</strong> (the app must use its pinned fallback)' : 'advertised normally'};
    refresh tokens are ${NO_REFRESH ? '<strong>not issued</strong>' : 'issued'};
    access tokens live ${TOKEN_TTL} seconds.
  </p>
</div></div></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN());
  const path = url.pathname;

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  /* ---- the mock EMR ---- */
  if (path === '/' || path === '/emr') {
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(EMR_PAGE());
  }

  /* ---- discovery ---- */
  if (path === '/fhir/r4/.well-known/smart-configuration' || path === '/.well-known/smart-configuration') {
    if (HIDE_DISCOVERY) { cors(res); res.writeHead(404); return res.end('not found'); }
    return sendJson(res, 200, smartConfiguration(), 'application/json; charset=utf-8');
  }
  if (path === '/fhir/r4/metadata') {
    return sendJson(res, 200, capabilityStatement());
  }

  /* ---- authorize ---- */
  if (path === '/oauth/authorize') {
    const q = url.searchParams;
    const redirect = q.get('redirect_uri');
    if (!redirect) { cors(res); res.writeHead(400); return res.end('missing redirect_uri'); }

    const launch = q.get('launch');
    const patientId = launch ? launchContexts.get(launch) : null;
    const to = new URL(redirect);

    if (launch && !patientId) {
      to.searchParams.set('error', 'invalid_request');
      to.searchParams.set('error_description', 'unknown launch context');
      if (q.get('state')) to.searchParams.set('state', q.get('state'));
      cors(res);
      res.writeHead(302, { Location: to.toString() });
      return res.end();
    }
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
      to.searchParams.set('error', 'invalid_request');
      to.searchParams.set('error_description', 'PKCE S256 required');
      if (q.get('state')) to.searchParams.set('state', q.get('state'));
      cors(res);
      res.writeHead(302, { Location: to.toString() });
      return res.end();
    }

    const code = `code-${Math.abs((seed = (seed * 48271) % 2147483647))}`;
    authCodes.set(code, {
      scope: q.get('scope') || '',
      patientId: patientId || PATIENT_ID,
      nonce: q.get('nonce') || null,
      challenge: q.get('code_challenge'),
      redirectUri: redirect,
    });
    to.searchParams.set('code', code);
    if (q.get('state')) to.searchParams.set('state', q.get('state'));
    cors(res);
    res.writeHead(302, { Location: to.toString() });
    return res.end();
  }

  /* ---- token ---- */
  if (path === '/oauth/token' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    const grant = form.get('grant_type');
    cors(res);

    if (grant === 'refresh_token') {
      const record = refreshTokens.get(form.get('refresh_token'));
      if (!record) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_grant' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        access_token: mintAccessToken(record.scope, record.patientId),
        token_type: 'Bearer',
        expires_in: TOKEN_TTL,
        scope: record.scope,
        patient: record.patientId,
      }));
    }

    if (grant !== 'authorization_code') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
    }

    const record = authCodes.get(form.get('code'));
    authCodes.delete(form.get('code')); // single use
    if (!record) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'unknown or reused code' }));
    }
    if (!form.get('code_verifier')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid_request', error_description: 'code_verifier required' }));
    }
    if (form.get('redirect_uri') !== record.redirectUri) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }));
    }

    const body = {
      access_token: mintAccessToken(record.scope, record.patientId),
      token_type: 'Bearer',
      expires_in: TOKEN_TTL,
      scope: record.scope,
      patient: record.patientId,
      id_token: mintIdToken(record.nonce),
    };
    if (!NO_REFRESH) {
      const rt = `rt-${Math.abs((seed = (seed * 48271) % 2147483647))}`;
      refreshTokens.set(rt, { scope: record.scope, patientId: record.patientId });
      body.refresh_token = rt;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(body));
  }

  /* ---- FHIR ---- */
  if (path.startsWith('/fhir/r4/')) {
    const [resourceType, id] = path.slice('/fhir/r4/'.length).split('/').filter(Boolean);
    const scopes = scopesFrom(req);

    if (scopes === null || scopes === 'expired') {
      cors(res);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: 'invalid_token',
        error_description: scopes === 'expired' ? 'access token expired' : 'bearer token required',
      }));
    }
    if (!scopeAllows(scopes, resourceType)) {
      return outcome(res, 403, `No SMART scope grants read access to ${resourceType}.`);
    }

    if (resourceType === 'Patient') {
      if (id && id !== PATIENT_ID) return outcome(res, 404, `Patient/${id} not found`);
      return sendJson(res, 200, id ? patient : bundle([patient]));
    }
    if (resourceType === 'Condition') {
      return sendJson(res, 200, bundle(conditions));
    }
    if (resourceType === 'Observation') {
      const wanted = (url.searchParams.get('category') || '').split(',').filter(Boolean);
      let rows = OBSERVATIONS;
      if (wanted.length) {
        rows = rows.filter((o) =>
          (o.category || []).some((c) => (c.coding || []).some((cd) => wanted.includes(cd.code)))
        );
      }
      // Real paging, so the client's `next`-following is actually exercised.
      const count = Math.min(Number(url.searchParams.get('_count')) || 50, 500);
      const offset = Number(url.searchParams.get('_offset')) || 0;
      const page = rows.slice(offset, offset + count);
      const links = [{ relation: 'self', url: `${FHIR_BASE()}/Observation${url.search}` }];
      if (offset + count < rows.length) {
        const nextParams = new URLSearchParams(url.searchParams);
        nextParams.set('_offset', String(offset + count));
        nextParams.set('_count', String(count));
        links.push({ relation: 'next', url: `${FHIR_BASE()}/Observation?${nextParams}` });
      }
      return sendJson(res, 200, { ...bundle(page), total: rows.length, link: links });
    }
    return outcome(res, 404, `Unsupported resource type ${resourceType}`);
  }

  /* ---- static app files ---- */
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const buf = await readFile(file);
    cors(res);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    return res.end(buf);
  } catch (_) {
    cors(res);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end(`not found: ${path}`);
  }
});

function bundle(resources) {
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    total: resources.length,
    entry: resources.map((r) => ({ fullUrl: `${FHIR_BASE()}/${r.resourceType}/${r.id}`, resource: r })),
  };
}

server.listen(PORT, () => {
  console.log(`mock EMR + gateway on ${ORIGIN()}`);
  console.log(`  EMR chart page   ${ORIGIN()}/`);
  console.log(`  FHIR base        ${FHIR_BASE()}`);
  console.log(`  launch context   ctx-adaeze-okonkwo → Patient/${PATIENT_ID}`);
  console.log(`  observations      ${OBSERVATIONS.length}`);
  console.log(`  discovery         ${HIDE_DISCOVERY ? 'HIDDEN (pinned fallback expected)' : 'advertised'}`);
  console.log(`  refresh token     ${NO_REFRESH ? 'not issued' : 'issued'}`);
  console.log(`  access token TTL  ${TOKEN_TTL}s`);
});
