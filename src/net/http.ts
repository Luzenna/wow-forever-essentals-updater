// Retry with exponential backoff and jitter, shared by the API client and downloads.

export class HttpError extends Error {
  status: number;
  headers: Headers | undefined;

  constructor(url: string, status: number, headers?: Headers) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.headers = headers;
  }
}

export const USER_AGENT = 'wow-forever-essentals-updater (+https://github.com/Luzenna/wow-forever-essentals-updater)';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Whether an error is worth retrying, and how long the server asked us to wait.
 */
export function classify(err: unknown): { retry: boolean; waitMs?: number } {
  if (err instanceof Error && (err as any).fatal) return { retry: false };
  // Local filesystem problems won't fix themselves by retrying.
  const code = (err as any)?.code;
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

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: {
    retries?: number;
    baseMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
    onRetry?: (err: unknown, attempt: number, waitMs: number) => void;
  } = {},
): Promise<T> {
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
