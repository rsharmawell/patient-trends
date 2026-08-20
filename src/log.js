/*
 * Structured logging.
 *
 * A production SMART app logs enough for someone to reconstruct a failed launch
 * from a browser console, and nothing that leaks a credential. `redact` is the
 * load-bearing part: tokens and authorization codes are truncated everywhere
 * they could otherwise be printed.
 */

import { CONFIG } from '../config.js';

const PREFIX = '[patient-trends]';

/** Truncate anything that looks like a credential down to a recognisable stub. */
export function redact(value) {
  if (typeof value !== 'string') return value;
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}…(${value.length} chars)`;
}

export function debug(...args) {
  if (CONFIG.debug) console.debug(PREFIX, ...args);
}

export function info(...args) {
  console.info(PREFIX, ...args);
}

export function warn(...args) {
  console.warn(PREFIX, ...args);
}

export function error(...args) {
  console.error(PREFIX, ...args);
}
