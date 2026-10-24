// @ts-check
// Streams an asset into the cache with HTTP Range resume, size and sha256
// checks, and retry with backoff. Completed zips are cached by version and digest.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError, USER_AGENT, classify, sleep } from './http.js';

/** @param {unknown} msg @returns {Error} */
const fatal = (msg) => Object.assign(new Error(String(msg)), { fatal: true });

/** Cache location: <cache>/downloads/<tag prefix>/<version>/<digest>/<asset>. @param {string} cacheDir @param {import('./catalog.js').Item} item @param {import('./sources/source.js').Release} rel */
export function cachePath(cacheDir, item, rel) {
  const id = rel.asset.sha256 ? rel.asset.sha256.slice(0, 16) : `size-${rel.asset.size}`;
  return path.join(cacheDir, 'downloads', item.cacheKey ?? item.tagPrefix ?? item.id, rel.version, id, rel.asset.name);
}

/** sha256 of a file, hex. @param {string} file @returns {Promise<string>} */
export async function sha256File(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) h.update(chunk);
  return h.digest('hex');
}

/** @param {string} f */
const sizeOf = (f) => {
  try {
    return fs.statSync(f).size;
  } catch {
    return -1;
  }
};

/** Bytes still to download for this file (accounts for a cached zip or a .part). @param {string} dest @param {number} size */
export function remainingBytes(dest, size) {
  if (sizeOf(dest) === size) return 0;
  return size - Math.max(0, Math.min(sizeOf(dest + '.part'), size));
}

/**
 * @param {import('./sources/source.js').Asset} asset
 * @param {string} dest final path of the zip
 * @param {{ fetchImpl?: typeof fetch, stallMs?: number, retry?: { retries?: number, baseMs?: number, sleepFn?: (ms: number) => Promise<void> },
 *           onProgress?: (done: number) => void, onRetry?: (err: unknown, attempt: number) => void }} [opts]
 * @returns {Promise<{ file: string, downloaded: number, cached: boolean }>}
 */
export async function download(asset, dest, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stallMs = opts.stallMs ?? 60_000;
  const { retries = 5, baseMs = 1000, sleepFn = sleep } = opts.retry ?? {};

  if (sizeOf(dest) === asset.size && (!asset.sha256 || (await sha256File(dest)) === asset.sha256)) {
    return { file: dest, downloaded: 0, cached: true };
  }
  fs.rmSync(dest, { force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  let downloaded = 0;
  let badHashes = 0;

  /** One attempt: fetch whatever is missing from .part, then verify. */
  const attempt = async () => {
    let start = sizeOf(part);
    if (start < 0 || start > asset.size) {
      fs.rmSync(part, { force: true });
      start = 0;
    }
    if (start < asset.size) {
      const ctrl = new AbortController();
      let timer = setTimeout(() => ctrl.abort(new Error('download stalled')), stallMs);
      const poke = () => {
        clearTimeout(timer);
        timer = setTimeout(() => ctrl.abort(new Error('download stalled')), stallMs);
      };
      try {
        /** @type {Record<string, string>} */
        const headers = { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' };
        if (start > 0) headers.Range = `bytes=${start}-`;
        const res = await fetchImpl(asset.url, { headers, signal: ctrl.signal, redirect: 'follow' });
        if (!res.ok || !res.body) {
          await res.body?.cancel().catch(() => {});
          // 416: our .part doesn't fit the server's file; start over next time.
          if (res.status === 416) fs.rmSync(part, { force: true });
          throw new HttpError(asset.url, res.status === 416 ? 500 : res.status, res.headers);
        }
        if (start > 0) {
          // Only append when the server really resumed where we asked.
          // A 200 means the server ignored Range and is sending the whole file.
          const m = /^bytes (\d+)-/.exec(res.headers.get('content-range') ?? '');
          if (res.status !== 206) start = 0;
          else if (!m || Number(m[1]) !== start) {
            await res.body.cancel().catch(() => {});
            fs.rmSync(part, { force: true });
            throw new Error('server resumed at the wrong offset; restarting');
          }
        }
        let done = start;
        opts.onProgress?.(done);
        const count = new Transform({
          transform(chunk, _enc, cb) {
            poke();
            done += chunk.length;
            downloaded += chunk.length;
            opts.onProgress?.(done);
            cb(null, chunk);
          },
        });
        // pipeline propagates write errors (disk full, permissions) as a rejection.
        await pipeline(
          Readable.fromWeb(/** @type {any} */ (res.body)),
          count,
          fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w' }),
          { signal: ctrl.signal },
        );
      } finally {
        clearTimeout(timer);
      }
    }
    const got = sizeOf(part);
    if (got !== asset.size) {
      if (got > asset.size) fs.rmSync(part, { force: true });
      throw new Error(`size mismatch: got ${got} bytes, expected ${asset.size}`);
    }
    if (asset.sha256) {
      const actual = await sha256File(part);
      if (actual !== asset.sha256) {
        fs.rmSync(part, { force: true });
        if (++badHashes > 1) throw fatal(`sha256 mismatch for ${asset.name} (expected ${asset.sha256}, got ${actual})`);
        throw new Error(`sha256 mismatch for ${asset.name}, retrying`);
      }
    }
  };

  // Retry with backoff. The failure budget resets whenever an attempt made
  // progress, so a slow, flaky connection still finishes a 1.4 GB download.
  // Only net growth of the .part file counts as progress, and there is a hard
  // cap on attempts so a misbehaving server can't keep us looping forever.
  for (let failures = 0, n = 0; ; ) {
    const before = Math.max(0, sizeOf(part));
    try {
      await attempt();
      break;
    } catch (err) {
      failures = sizeOf(part) > before ? 1 : failures + 1;
      const c = classify(err);
      if (!c.retry || failures > retries || n >= retries * 10) throw err;
      const wait = c.waitMs ?? Math.min(30_000, baseMs * 2 ** (failures - 1)) * (0.5 + Math.random() / 2);
      opts.onRetry?.(err, ++n);
      await sleepFn(wait);
    }
  }

  fs.renameSync(part, dest);
  return { file: dest, downloaded, cached: false };
}
