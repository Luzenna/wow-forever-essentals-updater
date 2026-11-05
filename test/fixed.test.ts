// An addon pinned to one file at a fixed URL (What's Training, for now): no network to
// find the release, the download is verified against the pinned size and sha256.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeZip, serve, sha256, tmpDir, toc } from './helpers.ts';
import { update } from '../src/commands/update.ts';
import { makePlan } from '../src/engine/plan.ts';
import { saveConfig, DEFAULT_CONFIG } from '../src/config/config.ts';
import { loadState, stateKey } from '../src/config/state.ts';
import { MultiSource } from '../src/sources/multi.ts';
import type { Source } from '../src/sources/source.ts';
import { fixedRelease } from '../src/sources/fixed.ts';
import { buildCatalog } from '../src/catalog/catalog.ts';
import { DEFAULT_SELECTED } from '../src/catalog/builtin.ts';

const opts = { language: 'enUS', includeZones: false, includeBooks: false };
const builtIn = () => buildCatalog({ ...opts, selected: ['whatstraining'] })[0];

test("What's Training is a built-in, opt-in, pinned to one file with its size and sha256", () => {
  assert.ok(!DEFAULT_SELECTED.includes('whatstraining'), 'opt-in');
  const item = builtIn();
  assert.equal(item.id, 'whatstraining');
  assert.ok(item.url && !item.wago && !item.repo);
  assert.deepEqual(item.folders, ['WhatsTraining']);
  const rel = fixedRelease(item);
  assert.equal(rel.version, '1.1.1');
  assert.equal(rel.asset.name, 'WhatsTraining-1.1.1.zip');
  assert.equal(rel.asset.size, 57758);
  assert.match(rel.asset.sha256 ?? '', /^[0-9a-f]{64}$/);
  assert.equal(new URL(rel.asset.url).protocol, 'https:');
});

test('a fixed file cannot be pinned to another version, and a missing entry is an error', () => {
  const item = builtIn();
  assert.equal(fixedRelease({ ...item, pin: 'v1.1.1' }).version, '1.1.1');
  assert.throws(() => fixedRelease({ ...item, pin: '1.0.0' }), /only available as 1\.1\.1, so 1\.0\.0 cannot be pinned/);
  assert.throws(() => fixedRelease({ ...item, url: undefined }), /no fixed file/);
});

/** A world where the pinned file is served locally, with the entry's href, size and sha256 swapped for it. */
async function world(served: Buffer, pin: { sha256?: string } = {}) {
  const home = tmpDir();
  const addons = path.join(home, 'wow', '_classic_beta_', 'Interface', 'AddOns');
  fs.mkdirSync(addons, { recursive: true });
  const configDir = path.join(home, 'config');
  saveConfig(configDir, { ...DEFAULT_CONFIG, addons_path: addons, selected: ['whatstraining'] });
  const srv = await serve({ '/files/WhatsTraining-1.1.1.zip': served });
  const real = new MultiSource({ retry: { retries: 0 } });
  const source: Source = {
    name: 'fixed',
    latest: (item) => real.latest({ ...item, url: { version: '1.1.1', href: `${srv.url}/files/WhatsTraining-1.1.1.zip`, size: served.length, sha256: pin.sha256 ?? sha256(served) } }),
  };
  return { addons, configDir, srv, deps: { source, configDir, cacheDir: path.join(home, 'cache'), runningWow: () => [], tty: false } };
}

const ZIP = makeZip({ 'WhatsTraining/WhatsTraining.toc': toc('1.1.1', '16001'), 'WhatsTraining/Core.lua': 'x' });

test('installs the pinned file, then reads as current without downloading again', async () => {
  const w = await world(ZIP);
  try {
    assert.equal(await update({ yes: true }, w.deps), 0);
    assert.deepEqual(fs.readdirSync(w.addons), ['WhatsTraining']);
    const st = loadState(w.configDir).installs[stateKey(w.addons)].whatstraining;
    assert.equal(st.version, '1.1.1');
    assert.equal(st.sha256, sha256(ZIP));
    const requests = w.srv.stats.requests;
    assert.deepEqual((await makePlan({}, w.deps)).plans.map((p) => p.status), ['current']);
    assert.equal(await update({ yes: true }, w.deps), 0);
    assert.equal(w.srv.stats.requests, requests, 'nothing is requested when it is current');
  } finally {
    await w.srv.close();
  }
});

test('a file that does not match the pinned sha256 is refused and nothing is installed', async () => {
  const w = await world(ZIP, { sha256: '0'.repeat(64) });
  try {
    assert.notEqual(await update({ yes: true }, w.deps), 0);
    assert.deepEqual(fs.readdirSync(w.addons), [], 'nothing was installed');
  } finally {
    await w.srv.close();
  }
});
