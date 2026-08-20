/*
 * FHIR R4 read client.
 *
 * Narrow on purpose: this app only reads. What it does add over bare fetch is
 * the behaviour a production app needs and a demo usually skips — bounded
 * retries with backoff on the transient statuses, `Bundle.link[rel=next]`
 * paging with a page cap, OperationOutcome unwrapping, and a single 401 path
 * that hands control back to the session layer instead of silently rendering
 * an empty screen.
 */

import { CONFIG } from '../config.js';
import { AppError } from './smart.js';
import { debug, warn } from './log.js';

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

export class FhirClient {
  /**
   * @param {string} baseUrl  FHIR base URL (the launch `iss`)
   * @param {() => string|null} getToken  returns the current access token
   * @param {() => void} onUnauthorized  called once when the server rejects the token
   */
  constructor(baseUrl, getToken, onUnauthorized) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.getToken = getToken;
    this.onUnauthorized = onUnauthorized;
    this.unauthorizedFired = false;
  }

  headers() {
    const h = { Accept: 'application/fhir+json' };
    const token = this.getToken();
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  /** Absolute URL for a relative FHIR path; absolute URLs pass through. */
  url(pathOrUrl) {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return `${this.baseUrl}/${String(pathOrUrl).replace(/^\//, '')}`;
  }

  async request(pathOrUrl) {
    const url = this.url(pathOrUrl);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res;
      try {
        res = await fetch(url, { headers: this.headers() });
      } catch (cause) {
        // A network-level failure on the last attempt is terminal. Cross-origin
        // is the overwhelmingly likely cause, so say so rather than "failed".
        if (attempt === MAX_ATTEMPTS) {
          throw new AppError(
            'FHIR_UNREACHABLE',
            'Could not reach the clinical record',
            `The browser could not complete a request to ${url}. If the server is up, the ` +
              'likely cause is a missing CORS response on the FHIR endpoint.',
            { cause }
          );
        }
        await backoff(attempt);
        continue;
      }

      if (res.status === 401) {
        if (!this.unauthorizedFired) {
          this.unauthorizedFired = true;
          this.onUnauthorized?.();
        }
        throw new AppError(
          'FHIR_UNAUTHORIZED',
          'Session no longer valid',
          'The FHIR server rejected the access token.'
        );
      }

      if (res.status === 403) {
        const outcome = await res.json().catch(() => null);
        throw new AppError(
          'FHIR_FORBIDDEN',
          'Not permitted',
          describeOutcome(outcome) ||
            'The server refused this read. The granted SMART scopes may not cover it.'
        );
      }

      if (RETRY_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(res.headers.get('retry-after'));
        debug(`retrying ${url} after HTTP ${res.status} (attempt ${attempt})`);
        await backoff(attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
        continue;
      }

      if (!res.ok) {
        const outcome = await res.json().catch(() => null);
        throw new AppError(
          'FHIR_ERROR',
          'The clinical record could not be read',
          `${url} returned HTTP ${res.status}. ${describeOutcome(outcome) || ''}`.trim()
        );
      }

      const body = await res.json().catch(() => null);
      if (!body) {
        throw new AppError(
          'FHIR_BAD_RESPONSE',
          'Unexpected response',
          `${url} returned a success status but the body was not JSON.`
        );
      }
      return body;
    }

    /* unreachable */
    throw new AppError('FHIR_ERROR', 'Request failed', url);
  }

  read(resourceType, id) {
    return this.request(`${resourceType}/${encodeURIComponent(id)}`);
  }

  /**
   * Search and follow `next` links, returning the flattened resources.
   *
   * Paging is capped by CONFIG.data.maxPages so a server that returns a
   * self-referential `next` cannot spin the tab. Hitting the cap is logged,
   * never silently truncated.
   */
  async searchAll(resourceType, params) {
    const query = new URLSearchParams(params);
    query.set('_count', String(CONFIG.data.pageSize));

    let url = `${resourceType}?${query}`;
    const resources = [];
    let pages = 0;

    while (url && pages < CONFIG.data.maxPages) {
      const bundle = await this.request(url);
      pages += 1;
      for (const entry of bundle.entry || []) {
        if (entry.resource?.resourceType === resourceType) resources.push(entry.resource);
      }
      const next = (bundle.link || []).find((l) => l.relation === 'next');
      url = next?.url || null;
    }

    if (url) {
      warn(
        `Stopped paging ${resourceType} at ${CONFIG.data.maxPages} pages ` +
          `(${resources.length} resources). Later pages were not read.`
      );
    }

    debug(`${resourceType}: ${resources.length} resources over ${pages} page(s)`);
    return { resources, pages, truncated: Boolean(url) };
  }
}

function describeOutcome(outcome) {
  if (outcome?.resourceType !== 'OperationOutcome') return '';
  return (outcome.issue || [])
    .map((i) => i.diagnostics || i.details?.text)
    .filter(Boolean)
    .join(' ');
}

function backoff(attempt, explicitMs) {
  // Exponential with jitter, so a burst of parallel requests does not retry in
  // lockstep against a server that is already struggling.
  const base = explicitMs ?? 300 * 2 ** (attempt - 1);
  const jitter = Math.random() * 150;
  return new Promise((r) => setTimeout(r, base + jitter));
}
