// @ts-check
// Several addons side by side: plain-tag single-folder addons next to Spoken, each
// confined to its own folders, plus the settings carried over from spoken-updater.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeZip, serve, sha256, snapshot, tmpDir, toc, writeTree } from './helpers.js';
import { update, makePlan } from '../src/app.js';
import { saveConfig, loadConfig, DEFAULT_CONFIG, loadState, stateKey, migrateLegacy, appDirs } from '../src/config.js';
import { workDirFor, legacyWorkDirFor } from '../src/swap.js';

/**
 * @typedef {{ version: string, tag: string, asset: string, files: Record<string, string> }} Upstream
 * Fake upstream: plain-tag addons keyed by item id.
 * @param {Record<string, Upstream>} table
 */
async function world(table, config = {}) {
  const home = tmpDir();
  const addons = path.join(home, 'wow', '_classic_beta_', 'Interface', 'AddOns');
  writeTree(addons, { 'Details/Details.toc': toc('1.0.0'), 'Details/Details.lua': 'keep me', 'Spoken/Spoken.toc': toc('3.1.0'), 'Spoken/Core.lua': 'mine' });
  const configDir = path.join(home, 'config');
  saveConfig(configDir, { ...DEFAULT_CONFIG, addons_path: addons, ...config });
  /** @type {Record<string, Buffer>} */
  const files = {};
  for (const [id, u] of Object.entries(table)) files[`/${id}.zip`] = makeZip(u.files);
  const srv = await serve(files);
  /** @type {import('../src/sources/source.js').Source} */
  const source = {
    name: 'Fake',
    async latest(item) {
      const u = table[item.id];
      if (!u) return null;
      const body = files[`/${item.id}.zip`];
      return { version: u.version, tag: u.tag, source: 'Fake', asset: { name: u.asset, url: `${srv.url}/${item.id}.zip`, size: body.length, sha256: sha256(body) } };
    },
  };
  const deps = { source, configDir, cacheDir: path.join(home, 'cache'), runningWow: () => [], tty: false };
  return { home, addons, configDir, srv, deps };
}

const NODESIGHT = { version: '1.4.1', tag: 'v1.4.1', asset: 'NodeSight-1.4.1.zip', files: { 'NodeSight/NodeSight.toc': toc('1.4.1'), 'NodeSight/NodeSight.lua': 'ns' } };
const DIALOGUE = {
  version: '1.0.5-f', tag: 'v1.0.5-f', asset: 'DialogueUI-1.0.5-f.zip',
  // Upstream's .toc says 1.0.5 for the -f rebuild.
  files: { 'DialogueUI/DialogueUI.toc': toc('1.0.5', '120100, 16001'), 'DialogueUI/Code.lua': 'dui', 'DialogueUI/.vscode/settings.json': '{}' },
};

test('plain-tag addons install next to Spoken without touching it, then settle', async () => {
  const w = await world({ nodesight: NODESIGHT, dialogueui: DIALOGUE }, { selected: ['nodesight', 'dialogueui'] });
  try {
    assert.equal(await update({ yes: true }, w.deps), 0);
    assert.deepEqual(fs.readdirSync(w.addons).sort(), ['Details', 'DialogueUI', 'NodeSight', 'Spoken']);
    assert.equal(fs.readFileSync(path.join(w.addons, 'Spoken/Core.lua'), 'utf8'), 'mine', 'Spoken is not selected, so it is left alone');
    assert.equal(fs.readFileSync(path.join(w.addons, 'Details/Details.lua'), 'utf8'), 'keep me');

    // .toc says 1.0.5 for tag v1.0.5-f: that must read as current, not outdated forever.
    const requests = w.srv.stats.requests;
    const before = snapshot(w.home);
    assert.equal(await update({ yes: true }, w.deps), 0);
    assert.equal(w.srv.stats.requests, requests, 'no downloads');
    assert.deepEqual(snapshot(w.home), before, 'nothing changed');
  } finally {
    await w.srv.close();
  }
});

test('unselected addons are not planned, and --only can still name them', async () => {
  const w = await world({ nodesight: NODESIGHT, dialogueui: DIALOGUE }, { selected: ['nodesight'] });
  try {
    assert.deepEqual((await makePlan({}, w.deps)).plans.map((p) => p.item.id), ['nodesight']);
    assert.deepEqual((await makePlan({ only: ['dialogueui'] }, w.deps)).plans.map((p) => p.item.id), ['dialogueui']);
    assert.equal(await update({ yes: true, only: ['dialogueui'] }, w.deps), 0);
    assert.ok(fs.existsSync(path.join(w.addons, 'DialogueUI/DialogueUI.toc')));
    assert.ok(!fs.existsSync(path.join(w.addons, 'NodeSight')), 'only what was named');
  } finally {
    await w.srv.close();
  }
});

test('a hand-installed copy is adopted when current, updated when not', async () => {
  const w = await world({ nodesight: NODESIGHT }, { selected: ['nodesight'] });
  try {
    writeTree(w.addons, { 'nodesight/NodeSight.toc': toc('1.4.1'), 'nodesight/NodeSight.lua': 'ns' }); // folder case differs
    assert.deepEqual((await makePlan({}, w.deps)).plans.map((p) => p.status), ['current']);
    writeTree(w.addons, { 'nodesight/NodeSight.toc': toc('1.3.0') });
    assert.deepEqual((await makePlan({}, w.deps)).plans.map((p) => p.status), ['outdated']);
  } finally {
    await w.srv.close();
  }
});

test('an addon only installs folders it owns', async () => {
  const sneaky = { ...NODESIGHT, files: { ...NODESIGHT.files, 'Details/Details.toc': toc('9.9.9'), 'Details/Details.lua': 'overwritten', 'Other/Other.toc': toc('1.0.0') } };
  const w = await world({ nodesight: sneaky }, { selected: ['nodesight'] });
  try {
    assert.equal(await update({ yes: true }, w.deps), 0);
    assert.deepEqual(fs.readdirSync(w.addons).sort(), ['Details', 'NodeSight', 'Spoken']);
    assert.equal(fs.readFileSync(path.join(w.addons, 'Details/Details.lua'), 'utf8'), 'keep me');
    assert.deepEqual(Object.keys(loadState(w.configDir).installs[stateKey(w.addons)].nodesight.folders), ['NodeSight']);
  } finally {
    await w.srv.close();
  }
});

test('an install interrupted under the old tool name is recovered', async () => {
  const w = await world({ nodesight: NODESIGHT }, { selected: ['nodesight'] });
  try {
    const legacy = legacyWorkDirFor(w.addons);
    assert.notEqual(legacy, workDirFor(w.addons));
    const bak = path.join(legacy, 'bak-1');
    writeTree(legacy, { 'bak-1/Old/Old.toc': toc('1.0.0') });
    fs.writeFileSync(path.join(legacy, 'journal.json'), JSON.stringify({ bakDir: bak, moves: [], committed: true }));
    assert.equal(await update({ yes: true }, w.deps), 0);
    assert.ok(!fs.existsSync(legacy), 'old work dir cleaned up');
    assert.ok(fs.existsSync(path.join(w.addons, 'NodeSight')));
  } finally {
    await w.srv.close();
  }
});

test('settings are carried over from spoken-updater once, and never overwritten', () => {
  const home = tmpDir();
  /** @type {NodeJS.ProcessEnv} */
  const env = process.platform === 'win32' ? { APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local') } : { XDG_CONFIG_HOME: path.join(home, 'cfg'), XDG_CACHE_HOME: path.join(home, 'cache') };
  const oldDir = appDirs(env, 'spoken-updater').config;
  const newDir = appDirs(env).config;
  assert.notEqual(oldDir, newDir);
  writeTree(oldDir, { 'config.json': JSON.stringify({ language: 'frFR', addons_path: 'X' }), 'state.json': '{"schema":1,"installs":{}}' });

  assert.equal(migrateLegacy(newDir, env), true);
  assert.equal(loadConfig(newDir).language, 'frFR');
  assert.deepEqual(loadConfig(newDir).selected, DEFAULT_CONFIG.selected, 'old configs gain every addon');
  assert.ok(fs.existsSync(path.join(oldDir, 'config.json')), 'copied, not moved');

  saveConfig(newDir, { ...loadConfig(newDir), language: 'deDE' });
  assert.equal(migrateLegacy(newDir, env), false);
  assert.equal(loadConfig(newDir).language, 'deDE');
  assert.equal(migrateLegacy(path.join(home, 'elsewhere'), { ...env, WFE_UPDATER_HOME: path.join(home, 'elsewhere') }), false, 'an explicit home is not legacy');
});

test('config selection keeps ids it does not know and never shares the default array', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ selected: ['nodesight', 'gone'] }));
  assert.deepEqual(loadConfig(dir).selected, ['nodesight', 'gone'], 'ids are kept: custom addons come from addons.json');
  const a = loadConfig(tmpDir());
  a.selected.pop();
  assert.equal(loadConfig(tmpDir()).selected.length, DEFAULT_CONFIG.selected.length);
});
