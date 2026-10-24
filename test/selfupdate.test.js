// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selfUpdate, selfAssetName, swapExecutable } from '../src/selfupdate.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selfupd-'));

/** Fake GitHub: the releases/latest JSON plus the asset download. */
function fakeFetch(tag, body, { digest = true, extra = {} } = {}) {
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const name = /** @type {string} */ (selfAssetName('linux', 'x64'));
  return /** @type {typeof fetch} */ (async (url) => {
    if (String(url).endsWith('/releases/latest')) {
      return Response.json({
        tag_name: tag, draft: false, prerelease: false, ...extra,
        assets: [{ name, size: body.length, browser_download_url: 'https://example/asset', digest: digest ? `sha256:${sha}` : null }],
      });
    }
    return new Response(body);
  });
}

test('asset names per platform', () => {
  assert.equal(selfAssetName('win32', 'x64'), 'wow-forever-essentals-updater.exe');
  assert.equal(selfAssetName('linux', 'x64'), 'wow-forever-essentals-updater-linux-x64');
  assert.equal(selfAssetName('darwin', 'arm64'), null);
  assert.equal(selfAssetName('linux', 'arm64'), null);
});

test('newer release replaces the executable and keeps the old one aside', async () => {
  const dir = tmp();
  const exe = path.join(dir, 'spoken-updater');
  fs.writeFileSync(exe, 'old');
  const r = await selfUpdate({ version: '0.1.0', exe, cacheDir: path.join(dir, 'cache'), platform: 'linux', arch: 'x64',
    fetchImpl: fakeFetch('v0.2.0', Buffer.from('new binary')), verify: () => {} });
  assert.equal(r, 'updated');
  assert.equal(fs.readFileSync(exe, 'utf8'), 'new binary');
  assert.equal(fs.readFileSync(exe + '.old', 'utf8'), 'old');
});

test('same or older release does nothing', async () => {
  const dir = tmp();
  const exe = path.join(dir, 'x');
  fs.writeFileSync(exe, 'old');
  for (const tag of ['v0.2.0', 'v0.1.0']) {
    const r = await selfUpdate({ version: '0.2.0', exe, cacheDir: dir, platform: 'linux', arch: 'x64', fetchImpl: fakeFetch(tag, Buffer.from('n')) });
    assert.equal(r, 'current');
  }
  assert.equal(fs.readFileSync(exe, 'utf8'), 'old');
});

test('a release without a digest is refused and the executable is untouched', async () => {
  const dir = tmp();
  const exe = path.join(dir, 'x');
  fs.writeFileSync(exe, 'old');
  await assert.rejects(
    selfUpdate({ version: '0.1.0', exe, cacheDir: dir, platform: 'linux', arch: 'x64', fetchImpl: fakeFetch('v0.2.0', Buffer.from('n'), { digest: false }) }),
    /no verifiable/,
  );
  assert.equal(fs.readFileSync(exe, 'utf8'), 'old');
});

test('a build that fails verification is not installed', async () => {
  const dir = tmp();
  const exe = path.join(dir, 'x');
  fs.writeFileSync(exe, 'old');
  await assert.rejects(
    selfUpdate({ version: '0.1.0', exe, cacheDir: dir, platform: 'linux', arch: 'x64', fetchImpl: fakeFetch('v0.2.0', Buffer.from('n')),
      verify: () => { throw new Error('boom'); } }),
    /boom/,
  );
  assert.equal(fs.readFileSync(exe, 'utf8'), 'old');
});

test('swapExecutable leaves no .new behind', () => {
  const dir = tmp();
  const exe = path.join(dir, 'x'), next = path.join(dir, 'n');
  fs.writeFileSync(exe, 'a');
  fs.writeFileSync(next, 'b');
  swapExecutable(exe, next);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['n', 'x', 'x.old']);
});
