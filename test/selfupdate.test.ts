import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selfUpdate, selfAssetName, swapExecutable, trySelfUpdate, newerSelfVersion, menuSelfUpdate, RELAUNCHED } from '../src/selfupdate.ts';
import type { spawnSync } from 'node:child_process';

type Seams = NonNullable<Parameters<typeof trySelfUpdate>[2]>;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'selfupd-'));

/** Fake GitHub: the releases/latest JSON plus the asset download. */
function fakeFetch(tag: string, body: Buffer, { digest = true, extra = {} }: { digest?: boolean; extra?: object } = {}) {
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const name = selfAssetName('linux', 'x64') as string;
  return (async (url) => {
    if (String(url).endsWith('/releases/latest')) {
      return Response.json({
        tag_name: tag, draft: false, prerelease: false, ...extra,
        assets: [{ name, size: body.length, browser_download_url: 'https://example/asset', digest: digest ? `sha256:${sha}` : null }],
      });
    }
    return new Response(body as unknown as BodyInit);
  }) as typeof fetch;
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

test('newerSelfVersion only looks: it names the newer version and downloads nothing', async () => {
  const seen: string[] = [];
  const f = fakeFetch('v0.3.0', Buffer.from('n'));
  const spy = (async (u: Parameters<typeof fetch>[0], i?: RequestInit) => { seen.push(String(u)); return f(u, i); }) as typeof fetch;
  assert.equal(await newerSelfVersion({ version: '0.2.0', platform: 'linux', arch: 'x64', fetchImpl: spy }), '0.3.0');
  assert.equal(await newerSelfVersion({ version: '0.3.0', platform: 'linux', arch: 'x64', fetchImpl: spy }), null);
  assert.equal(await newerSelfVersion({ version: '0.1.0', platform: 'darwin', arch: 'arm64', fetchImpl: spy }), null, 'no build for this platform');
  assert.ok(seen.every((u) => u.endsWith('/releases/latest')), 'only the release lookup, never the asset');
});

test('menuSelfUpdate exists only in the packaged build', () => {
  assert.equal(menuSelfUpdate('dev', tmp(), true), undefined);
  assert.equal(menuSelfUpdate('1.0.0', tmp(), false), undefined);
  assert.ok(menuSelfUpdate('1.0.0', tmp(), true));
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

/** Seams for trySelfUpdate that record what happened instead of replacing and restarting anything. */
function seams(o: { result?: 'updated' | 'current'; fail?: boolean; spawnResult?: unknown; env?: NodeJS.ProcessEnv } = {}) {
  const calls = { update: 0, spawn: [] as { exe: string; args: string[]; opts: { stdio: string; env: Record<string, string> } }[], exit: [] as number[] };
  return {
    calls,
    seams: {
      isSea: true, exe: '/app/updater', args: ['--yes', 'update'], env: o.env ?? {},
      update: (async () => {
        calls.update++;
        if (o.fail) throw new Error('offline');
        return o.result ?? 'updated';
      }) as unknown as typeof selfUpdate,
      spawn: ((exe: string, args: string[], opts: { stdio: string; env: Record<string, string> }) => {
        calls.spawn.push({ exe, args, opts });
        return o.spawnResult ?? { status: 0 };
      }) as unknown as typeof spawnSync,
      exit: (code: number) => void calls.exit.push(code),
    } as Seams,
  };
}

test('after an update the new executable is started with the same arguments, and its exit code is ours', async () => {
  const t = seams({ spawnResult: { status: 3 } });
  await trySelfUpdate('1.0.0', '/cache', t.seams);
  assert.equal(t.calls.spawn.length, 1);
  assert.equal(t.calls.spawn[0].exe, '/app/updater');
  assert.deepEqual(t.calls.spawn[0].args, ['--yes', 'update']);
  assert.equal(t.calls.spawn[0].opts.stdio, 'inherit', 'same terminal');
  assert.equal(t.calls.spawn[0].opts.env[RELAUNCHED], '1', 'the new copy is told not to update again');
  assert.deepEqual(t.calls.exit, [3]);
});

test('no restart when there was nothing to update, or the check failed, or this is a dev run', async () => {
  for (const o of [{ result: 'current' as const }, { fail: true }]) {
    const t = seams(o);
    await trySelfUpdate('1.0.0', '/cache', t.seams);
    assert.equal(t.calls.update, 1);
    assert.deepEqual([t.calls.spawn.length, t.calls.exit.length], [0, 0]);
  }
  const dev = seams();
  await trySelfUpdate('dev', '/cache', dev.seams);
  await trySelfUpdate('1.0.0', '/cache', { ...dev.seams, isSea: false });
  assert.equal(dev.calls.update, 0);
});

test('the restarted copy does not check for an update, so it cannot restart forever', async () => {
  const t = seams({ env: { [RELAUNCHED]: '1' } });
  await trySelfUpdate('1.0.0', '/cache', t.seams);
  assert.deepEqual([t.calls.update, t.calls.spawn.length, t.calls.exit.length], [0, 0, 0]);
});

test('if the new copy cannot be started, this one carries on instead of exiting', async () => {
  const t = seams({ spawnResult: { error: new Error('EACCES') } });
  await trySelfUpdate('1.0.0', '/cache', t.seams);
  assert.equal(t.calls.spawn.length, 1);
  assert.deepEqual(t.calls.exit, []);
});

test('a real child process: its exit code comes back and it sees the do-not-update flag', async () => {
  const t = seams();
  const real = { ...t.seams, exe: process.execPath, args: ['-e', `process.exit(process.env.${RELAUNCHED} === '1' ? 7 : 1)`], spawn: undefined };
  await trySelfUpdate('1.0.0', '/cache', real as Seams);
  assert.deepEqual(t.calls.exit, [7]);
});
