// @ts-check
// Retry with exponential backoff and jitter, shared by the API client and downloads.

export class HttpError extends Error {
  /** @param {string} url @param {number} status @param {Headers} [headers] */
  constructor(url, status, headers) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.headers = headers;
  }
}

export const USER_AGENT = 'wow-forever-essentals-updater (+https://github.com/Luzenna/wow-forever-essentals-updater)';

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Whether an error is worth retrying, and how long the server asked us to wait.
 * @param {unknown} err @returns {{ retry: boolean, waitMs?: number }}
 */
export function classify(err) {
  if (err instanceof Error && /** @type {any} */ (err).fatal) return { retry: false };
  // Local filesystem problems won't fix themselves by retrying.
  const code = /** @type {any} */ (err)?.code;
  if (['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EISDIR', 'EDQUOT'].includes(code)) return { retry: false };
  if (err instanceof HttpError) {
    const h = err.headers;
    const retryAfter = Number(h?.get('retry-after'));
    if (err.status === 429 || err.status >= 500) {
      return { retry: true, waitMs: retryAfter > 0 ? retryAfter * 1000 : undefined };
    }
    if (err.status === 403 && h?.get('x-ratelimit-remaining') === '0') {
      const reset = Number(h.get('x-ratelimit-reset')) * 1000 - Date.now();
      // Don't sit around for most of an hour; surface it so the user can set a token.
      return reset > 0 && reset < 120_000 ? { retry: true, waitMs: reset + 1000 } : { retry: false };
    }
    return { retry: false };
  }
  // fetch() network failures, aborted stalls, ECONNRESET and friends.
  return { retry: true };
}

/**
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {{ retries?: number, baseMs?: number, sleepFn?: (ms: number) => Promise<void>, onRetry?: (err: unknown, attempt: number, waitMs: number) => void }} [opts]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, opts = {}) {
  const { retries = 5, baseMs = 1000, sleepFn = sleep, onRetry } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const c = classify(err);
      if (!c.retry || attempt >= retries) throw err;
      const wait = c.waitMs ?? Math.min(30_000, baseMs * 2 ** attempt) * (0.5 + Math.random() / 2);
      onRetry?.(err, attempt + 1, wait);
      await sleepFn(wait);
    }
  }
}
