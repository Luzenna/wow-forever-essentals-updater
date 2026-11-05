import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { serve, sha256, tmpDir } from './helpers.ts';
import { download } from '../src/net/download.ts';
import type { Asset } from '../src/sources/source.ts';

const BODY = crypto.randomBytes(256 * 1024);
const fast = { retries: 3, baseMs: 1, sleepFn: async () => {} };

const asset = (url: string, over: Partial<Asset> = {}): Asset => ({ name: 'x.zip', url, size: BODY.length, sha256: sha256(BODY), ...over });

test('downloads, verifies and reuses the cached file', async () => {
  const srv = await serve({ '/x.zip': BODY });
  try {
    const dest = path.join(tmpDir(), 'c', 'x.zip');
    const first = await download(asset(srv.url + '/x.zip'), dest, { retry: fast });
    assert.equal(first.downloaded, BODY.length);
    assert.deepEqual(fs.readFileSync(dest), BODY);
    const again = await download(asset(srv.url + '/x.zip'), dest, { retry: fast });
    assert.equal(again.cached, true);
    assert.equal(srv.stats.requests, 1, 'second call made no request');
  } finally {
    await srv.close();
  }
});

test('resumes a partial download with a Range request', async () => {
  const srv = await serve({ '/x.zip': BODY });
  try {
    const dest = path.join(tmpDir(), 'x.zip');
    fs.writeFileSync(dest + '.part', BODY.subarray(0, 100_000));
    const r = await download(asset(srv.url + '/x.zip'), dest, { retry: fast });
    assert.deepEqual(srv.stats.ranges, ['bytes=100000-']);
    assert.equal(r.downloaded, BODY.length - 100_000);
    assert.deepEqual(fs.readFileSync(dest), BODY);
  } finally {
    await srv.close();
  }
});

test('restarts from zero when the server ignores Range', async () => {
  const srv = await serve({ '/x.zip': BODY }, { ignoreRange: true });
  try {
    const dest = path.join(tmpDir(), 'x.zip');
    fs.writeFileSync(dest + '.part', Buffer.from('garbage'));
    await download(asset(srv.url + '/x.zip'), dest, { retry: fast });
    assert.deepEqual(fs.readFileSync(dest), BODY);
  } finally {
    await srv.close();
  }
});

test('retries after server errors', async () => {
  const srv = await serve({ '/x.zip': BODY }, { failFirst: 2 });
  try {
    const dest = path.join(tmpDir(), 'x.zip');
    let retries = 0;
    await download(asset(srv.url + '/x.zip'), dest, { retry: fast, onRetry: () => retries++ });
    assert.equal(retries, 2);
    assert.deepEqual(fs.readFileSync(dest), BODY);
  } finally {
    await srv.close();
  }
});

test('sha256 mismatch fails after one retry and leaves no file', async () => {
  const srv = await serve({ '/x.zip': BODY });
  try {
    const dest = path.join(tmpDir(), 'x.zip');
    await assert.rejects(download(asset(srv.url + '/x.zip', { sha256: '00'.repeat(32) }), dest, { retry: fast }), /sha256 mismatch/);
    assert.equal(srv.stats.requests, 2);
    assert.ok(!fs.existsSync(dest) && !fs.existsSync(dest + '.part'));
  } finally {
    await srv.close();
  }
});

test('size mismatch is detected', async () => {
  const srv = await serve({ '/x.zip': BODY });
  try {
    const dest = path.join(tmpDir(), 'x.zip');
    await assert.rejects(download(asset(srv.url + '/x.zip', { size: BODY.length + 1, sha256: null }), dest, { retry: { ...fast, retries: 1 } }), /size mismatch/);
  } finally {
    await srv.close();
  }
});

test('404 is not retried', async () => {
  const srv = await serve({});
  try {
    await assert.rejects(download(asset(srv.url + '/missing.zip'), path.join(tmpDir(), 'x.zip'), { retry: fast }), /HTTP 404/);
    assert.equal(srv.stats.requests, 1);
  } finally {
    await srv.close();
  }
});

test('a 206 at the wrong offset is discarded and the download restarts cleanly', async () => {
  let first = true;
  const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
    if (init.headers.Range && first) {
      first = false;
      // Claims to resume from 0 although we asked for 100000.
      return new Response(BODY, { status: 206, headers: { 'content-range': `bytes 0-${BODY.length - 1}/${BODY.length}` } });
    }
    return new Response(BODY, { status: 200 });
  }) as unknown as typeof fetch;
  const dest = path.join(tmpDir(), 'x.zip');
  fs.writeFileSync(dest + '.part', BODY.subarray(0, 100_000));
  await download(asset('http://fake/x.zip'), dest, { retry: fast, fetchImpl });
  assert.deepEqual(fs.readFileSync(dest), BODY);
});

test('a server that never delivers the full file cannot cause an endless loop', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(BODY.subarray(0, 1000), { status: 200 }); // always truncated, from 0
  }) as typeof fetch;
  await assert.rejects(download(asset('http://fake/x.zip'), path.join(tmpDir(), 'x.zip'), { retry: fast, fetchImpl }), /size mismatch/);
  assert.ok(calls <= 31, `gave up after ${calls} attempts`);
});

test('a local write error fails the download instead of crashing the process', async () => {
  const srv = await serve({ '/x.zip': BODY });
  try {
    const dest = path.join(tmpDir(), 'x.zip');
    fs.mkdirSync(dest + '.part'); // writing to a directory fails (EISDIR)
    await assert.rejects(download(asset(srv.url + '/x.zip'), dest, { retry: fast }), /EISDIR|EPERM|illegal operation|operation not permitted/i);
  } finally {
    await srv.close();
  }
});
