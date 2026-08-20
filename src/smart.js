/*
 * SMART App Launch — EHR launch only.
 *
 * The flow, end to end:
 *
 *   EMR opens  launch.html?iss=<fhir base>&launch=<opaque context>
 *     │
 *     ├─ validate `iss` against CONFIG.trustedIssuers      ← security boundary
 *     ├─ discover the authorization server from `iss`
 *     ├─ mint PKCE verifier + state + nonce, stash them
 *     └─ redirect to the authorization endpoint
 *          │
 *   index.html?code=…&state=…
 *     ├─ verify state, exchange the code (PKCE, public client)
 *     ├─ verify the id_token nonce when one is returned
 *     └─ hold the session: silent refresh + idle timeout
 *
 * No part of this reads configuration from the URL or from user input. `iss`
 * and `launch` are the only inputs, and `iss` is checked against a pinned list
 * before the app will talk to it.
 */

import { CONFIG } from '../config.js';
import { debug, info, warn, redact } from './log.js';

const PENDING_KEY = 'polaris.pv.pending';
const SESSION_KEY = 'polaris.pv.session';

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/**
 * An error the app knows how to show the user. `code` is stable enough to
 * quote in a support conversation; `detail` is for the person reading it.
 */
export class AppError extends Error {
  constructor(code, title, detail, { cause } = {}) {
    super(`${code}: ${title}`);
    this.code = code;
    this.title = title;
    this.detail = detail;
    this.cause = cause;
  }
}

/* ------------------------------------------------------------------ *
 * Issuer validation
 * ------------------------------------------------------------------ */

function normalise(url) {
  return String(url || '').replace(/\/+$/, '');
}

/**
 * Only launch from an issuer this deployment was registered against.
 *
 * Matching is exact-or-prefix on the normalised URL, and the prefix has to
 * break on a `/` so that `https://evil.com/fhir/r4.attacker.net` cannot pass
 * as a prefix match for `https://evil.com/fhir/r4`.
 */
export function validateIssuer(iss) {
  const candidate = normalise(iss);
  if (!candidate) {
    throw new AppError(
      'LAUNCH_MISSING_ISS',
      'Incomplete launch',
      'The EHR did not supply an issuer (iss). This app can only be opened from an EHR launch.'
    );
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (_) {
    throw new AppError(
      'LAUNCH_BAD_ISS',
      'Invalid launch',
      'The issuer supplied by the EHR is not a valid URL.'
    );
  }
  if (parsed.protocol !== 'https:' && !isLoopback(parsed.hostname)) {
    throw new AppError(
      'LAUNCH_INSECURE_ISS',
      'Insecure launch',
      `Refusing to launch against a plaintext issuer (${parsed.origin}). ` +
        'Only https issuers are accepted, apart from loopback addresses used in local development.'
    );
  }

  // The loopback entries in trustedIssuers exist so local development and the
  // bundled mock work. They must not survive deployment: once the app is served
  // from a real https origin, a loopback issuer can only be an attacker
  // pointing it at something on the clinician's own machine. This makes the
  // dev-only entries inert in production without anyone having to remember to
  // strip them before a deploy.
  const appIsDeployed = location.protocol === 'https:' && !isLoopback(location.hostname);
  const usable = CONFIG.trustedIssuers.filter((t) => {
    if (!appIsDeployed) return true;
    try {
      return !isLoopback(new URL(normalise(t)).hostname);
    } catch (_) {
      return false;
    }
  });

  const trusted = usable.map(normalise).some(
    (t) => candidate === t || candidate.startsWith(t + '/')
  );
  if (!trusted) {
    throw new AppError(
      'LAUNCH_UNTRUSTED_ISS',
      'Launch refused',
      `This app is not registered to launch from ${parsed.origin}. ` +
        'An EHR launch can only come from an issuer on this deployment’s trusted list. ' +
        'If this is a new environment, add it to config.js and redeploy.'
    );
  }
  return candidate;
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

const OAUTH_URIS_EXT =
  'http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch (_) {
    return null;
  }
}

function endpointsFromSmartConfiguration(doc) {
  if (!doc?.authorization_endpoint || !doc?.token_endpoint) return null;
  return {
    authorizationEndpoint: doc.authorization_endpoint,
    tokenEndpoint: doc.token_endpoint,
    capabilities: doc.capabilities || [],
    scopesSupported: doc.scopes_supported || [],
    codeChallengeMethods: doc.code_challenge_methods_supported || [],
  };
}

function endpointsFromCapabilityStatement(doc) {
  for (const rest of doc?.rest || []) {
    const ext = (rest.security?.extension || []).find((e) => e.url === OAUTH_URIS_EXT);
    if (!ext) continue;
    const map = {};
    for (const sub of ext.extension || []) {
      map[sub.url] = sub.valueUri || sub.valueUrl || sub.value;
    }
    if (map.authorize && map.token) {
      return {
        authorizationEndpoint: map.authorize,
        tokenEndpoint: map.token,
        capabilities: [],
        scopesSupported: [],
        codeChallengeMethods: [],
      };
    }
  }
  return null;
}

/**
 * Resolve the authorization server for an issuer, in spec order.
 *
 * Returns `{ authorizationEndpoint, tokenEndpoint, source, … }`. Throws only
 * when all three routes fail — a deployment that has neither working discovery
 * nor a pinned entry genuinely cannot launch.
 */
export async function discover(iss) {
  const base = normalise(iss);

  // 1 — the location the SMART App Launch spec defines, relative to the FHIR base.
  const sc = await fetchJson(`${base}/.well-known/smart-configuration`);
  const fromSc = endpointsFromSmartConfiguration(sc);
  if (fromSc) {
    debug('discovery: smart-configuration', fromSc.authorizationEndpoint);
    return { ...fromSc, source: 'smart-configuration' };
  }

  // 2 — the CapabilityStatement's oauth-uris extension.
  const cap = await fetchJson(`${base}/metadata`);
  const fromCap = endpointsFromCapabilityStatement(cap);
  if (fromCap) {
    debug('discovery: CapabilityStatement oauth-uris', fromCap.authorizationEndpoint);
    return { ...fromCap, source: 'capability-statement' };
  }

  // 3 — pinned fallback. Loud on purpose: this branch means the server is not
  // advertising itself the way the spec requires, and every other SMART client
  // pointed at it will fail where this one keeps going.
  const pinned = CONFIG.pinnedEndpoints[base];
  if (pinned) {
    warn(
      `Discovery failed for ${base}. Neither ${base}/.well-known/smart-configuration ` +
        `nor the oauth-uris extension on ${base}/metadata returned usable endpoints, ` +
        'so the app is falling back to endpoints pinned in config.js. ' +
        'A conformant SMART client would stop here.'
    );
    return {
      ...pinned,
      capabilities: [],
      scopesSupported: [],
      codeChallengeMethods: [],
      source: 'pinned-fallback',
    };
  }

  throw new AppError(
    'DISCOVERY_FAILED',
    'Cannot reach the authorization server',
    `The FHIR server at ${base} did not advertise its SMART endpoints. Tried ` +
      `${base}/.well-known/smart-configuration and the oauth-uris extension on ` +
      `${base}/metadata, and no fallback is pinned for this issuer in config.js. ` +
      'A cross-origin failure here usually means the endpoint is reachable but is ' +
      'missing CORS headers.'
  );
}

/* ------------------------------------------------------------------ *
 * PKCE
 * ------------------------------------------------------------------ */

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLength = 48) {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

async function codeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/* ------------------------------------------------------------------ *
 * Redirect URI
 * ------------------------------------------------------------------ */

/**
 * The redirect URI, derived from where the app is actually deployed so it can
 * never drift from the registered value by a trailing slash. Both entry points
 * resolve to the same string.
 */
export function redirectUri() {
  let path = location.pathname;
  if (/\/(launch|index)\.html$/.test(path)) path = path.replace(/\/[^/]+$/, '/index.html');
  else if (path.endsWith('/')) path += 'index.html';
  else path += '/index.html';
  return location.origin + path;
}

/* ------------------------------------------------------------------ *
 * Launch
 * ------------------------------------------------------------------ */

/**
 * Start an EHR launch. Navigates away; never returns normally.
 */
export async function beginLaunch({ iss, launch }) {
  const base = validateIssuer(iss);

  if (!launch) {
    throw new AppError(
      'LAUNCH_MISSING_CONTEXT',
      'Incomplete launch',
      'The EHR supplied an issuer but no launch context. This app runs as an EHR-launched ' +
        'app and needs the launch parameter to resolve which patient to show.'
    );
  }

  const server = await discover(base);

  if (
    server.codeChallengeMethods.length &&
    !server.codeChallengeMethods.includes('S256')
  ) {
    throw new AppError(
      'PKCE_UNSUPPORTED',
      'Authorization server cannot be used',
      'This app is a public client and authenticates with PKCE (S256). The authorization ' +
        `server advertises only: ${server.codeChallengeMethods.join(', ')}.`
    );
  }

  const verifier = randomString();
  const challenge = await codeChallenge(verifier);
  const state = randomString(16);
  const nonce = randomString(16);
  const redirect = redirectUri();

  sessionStorage.setItem(
    PENDING_KEY,
    JSON.stringify({
      fhirBaseUrl: base,
      tokenEndpoint: server.tokenEndpoint,
      authorizationEndpoint: server.authorizationEndpoint,
      discoverySource: server.source,
      redirectUri: redirect,
      verifier,
      state,
      nonce,
      startedAt: Date.now(),
    })
  );

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CONFIG.clientId,
    redirect_uri: redirect,
    scope: CONFIG.scopes.join(' '),
    state,
    nonce,
    aud: base,
    launch,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  const target = `${server.authorizationEndpoint}${
    server.authorizationEndpoint.includes('?') ? '&' : '?'
  }${params}`;

  info(`launching against ${base} via ${server.source}`);
  location.assign(target);
}

/**
 * Handle the redirect back from the authorization server and produce a session.
 */
export async function completeLaunch(query) {
  const raw = sessionStorage.getItem(PENDING_KEY);
  if (!raw) {
    throw new AppError(
      'NO_PENDING_LAUNCH',
      'Session not found',
      'This page received an authorization response, but there is no launch in progress in ' +
        'this browser tab. Start again from the EHR.'
    );
  }
  const pending = JSON.parse(raw);
  sessionStorage.removeItem(PENDING_KEY);

  if (query.get('error')) {
    throw new AppError(
      'AUTHORIZATION_DENIED',
      'Authorization was not granted',
      `The authorization server returned "${query.get('error')}"` +
        (query.get('error_description') ? `: ${query.get('error_description')}` : '.')
    );
  }

  // Constant-time-ish comparison is overkill here (state is single-use and
  // already in the attacker's URL) but a strict equality check is mandatory.
  if (!query.get('state') || query.get('state') !== pending.state) {
    throw new AppError(
      'STATE_MISMATCH',
      'Authorization could not be verified',
      'The state parameter returned by the authorization server does not match the one this ' +
        'app sent. The response was discarded. Start again from the EHR.'
    );
  }

  const code = query.get('code');
  if (!code) {
    throw new AppError(
      'NO_CODE',
      'Authorization incomplete',
      'The authorization server redirected back without an authorization code.'
    );
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: pending.redirectUri,
    client_id: CONFIG.clientId,
    code_verifier: pending.verifier,
  });

  let res;
  try {
    res = await fetch(pending.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch (cause) {
    throw new AppError(
      'TOKEN_UNREACHABLE',
      'Could not reach the token endpoint',
      `The browser could not POST to ${pending.tokenEndpoint}. A public SMART client needs ` +
        'the token endpoint to allow cross-origin requests from this app’s origin.',
      { cause }
    );
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.access_token) {
    throw new AppError(
      'TOKEN_EXCHANGE_FAILED',
      'Could not complete sign-in',
      `The token endpoint returned HTTP ${res.status}` +
        (payload?.error ? ` (${payload.error}${payload.error_description ? ': ' + payload.error_description : ''})` : '') +
        '.'
    );
  }

  verifyNonce(payload.id_token, pending.nonce);

  const patientId = payload.patient || patientFromToken(payload.access_token);
  if (!patientId) {
    throw new AppError(
      'NO_PATIENT_CONTEXT',
      'No patient in this launch',
      'The authorization server granted a token but did not return patient context. An EHR ' +
        'launch of a patient viewer must resolve to a patient — check that the launch ' +
        'parameter was passed through and that the launch/patient scope was granted.'
    );
  }

  const session = {
    fhirBaseUrl: pending.fhirBaseUrl,
    tokenEndpoint: pending.tokenEndpoint,
    discoverySource: pending.discoverySource,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || null,
    idToken: payload.id_token || null,
    scope: payload.scope || CONFIG.scopes.join(' '),
    patientId: String(patientId),
    expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
    fhirUser: decodeJwt(payload.id_token)?.fhirUser || decodeJwt(payload.access_token)?.fhirUser || null,
  };

  persist(session);
  info(
    `session established for Patient/${session.patientId}`,
    `token ${redact(session.accessToken)}`,
    session.refreshToken ? 'refresh token issued' : 'no refresh token'
  );
  if (!session.refreshToken) {
    warn(
      'The authorization server did not issue a refresh token, so the session cannot be ' +
        'renewed silently. The app will ask for a fresh EHR launch when the token expires.'
    );
  }
  return session;
}

function verifyNonce(idToken, expected) {
  if (!idToken) return; // no id_token requested or returned — nothing to check
  const claims = decodeJwt(idToken);
  if (!claims) return;
  if (claims.nonce && claims.nonce !== expected) {
    throw new AppError(
      'NONCE_MISMATCH',
      'Identity token could not be verified',
      'The nonce in the returned id_token does not match the one this app sent.'
    );
  }
}

export function decodeJwt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))));
  } catch (_) {
    return null;
  }
}

function patientFromToken(token) {
  const claims = decodeJwt(token);
  if (!claims) return null;
  if (claims.patient) return claims.patient;
  if (typeof claims.fhirUser === 'string' && claims.fhirUser.includes('Patient/')) {
    return claims.fhirUser.split('Patient/').pop();
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Session storage
 *
 * sessionStorage, not localStorage: the token dies with the tab, is never
 * shared with another tab, and survives only the redirect round-trip it has to
 * survive. A browser-only public client has no better option — there is no
 * confidential backend to hold it.
 * ------------------------------------------------------------------ */

function persist(session) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch (_) {
    warn('sessionStorage is unavailable; the session will not survive a reload.');
  }
}

export function restoreSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session?.accessToken || !session?.patientId) return null;
    return session;
  } catch (_) {
    return null;
  }
}

export function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(PENDING_KEY);
}

/* ------------------------------------------------------------------ *
 * Refresh
 * ------------------------------------------------------------------ */

/**
 * Exchange the refresh token for a new access token. Resolves to the updated
 * session, or null when the session cannot be renewed (no refresh token, or
 * the server refused) — the caller then asks for a fresh EHR launch.
 */
export async function refreshSession(session) {
  if (!session.refreshToken) return null;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
    client_id: CONFIG.clientId,
  });

  let res;
  try {
    res = await fetch(session.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch (_) {
    warn('refresh failed: token endpoint unreachable');
    return null;
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.access_token) {
    warn(`refresh refused (HTTP ${res.status})`, payload?.error || '');
    return null;
  }

  const updated = {
    ...session,
    accessToken: payload.access_token,
    // Rotating servers issue a new refresh token; non-rotating ones don't.
    refreshToken: payload.refresh_token || session.refreshToken,
    scope: payload.scope || session.scope,
    expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
  };
  persist(updated);
  debug('access token refreshed, expires', new Date(updated.expiresAt).toISOString());
  return updated;
}

/**
 * Owns the live session: keeps the access token fresh and enforces the idle
 * timeout. `onExpired` fires once, when the session can no longer be used.
 */
export class SessionManager {
  constructor(session, { onExpired, onIdleWarning, onIdleCleared }) {
    this.session = session;
    this.onExpired = onExpired;
    this.onIdleWarning = onIdleWarning;
    this.onIdleCleared = onIdleCleared;
    this.refreshTimer = null;
    this.idleTimer = null;
    this.graceTimer = null;
    this.stopped = false;
    this.activityHandler = () => this.noteActivity();
  }

  start() {
    for (const evt of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
      window.addEventListener(evt, this.activityHandler, { passive: true });
    }
    this.scheduleRefresh();
    this.noteActivity();
  }

  stop() {
    this.stopped = true;
    for (const evt of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
      window.removeEventListener(evt, this.activityHandler);
    }
    clearTimeout(this.refreshTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.graceTimer);
  }

  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    const lead = CONFIG.session.refreshLeadSeconds * 1000;
    // setTimeout saturates past ~24.8 days; clamp so a long-lived token does
    // not schedule a callback that fires immediately.
    const delay = Math.min(
      Math.max(this.session.expiresAt - Date.now() - lead, 0),
      2 ** 31 - 1
    );
    this.refreshTimer = setTimeout(() => this.doRefresh(), delay);
    debug(`refresh scheduled in ${Math.round(delay / 1000)}s`);
  }

  async doRefresh() {
    if (this.stopped) return;
    const updated = await refreshSession(this.session);
    if (!updated) {
      this.expire('TOKEN_EXPIRED');
      return;
    }
    this.session = updated;
    this.scheduleRefresh();
  }

  noteActivity() {
    if (this.stopped) return;
    clearTimeout(this.idleTimer);
    clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.onIdleCleared?.();
    this.idleTimer = setTimeout(
      () => this.beginIdleGrace(),
      CONFIG.session.idleTimeoutSeconds * 1000
    );
  }

  beginIdleGrace() {
    if (this.stopped) return;
    this.onIdleWarning?.(CONFIG.session.idleGraceSeconds);
    this.graceTimer = setTimeout(
      () => this.expire('IDLE_TIMEOUT'),
      CONFIG.session.idleGraceSeconds * 1000
    );
  }

  expire(reason) {
    if (this.stopped) return;
    this.stop();
    clearSession();
    info(`session ended: ${reason}`);
    this.onExpired?.(reason);
  }

  /** Current access token, or null once the session has lapsed. */
  token() {
    if (this.stopped) return null;
    return this.session.accessToken;
  }
}
