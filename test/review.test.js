// @ts-check
// Follow-ups from the code review of custom addons, removal, pins and developer copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { makeZip, serve, sha256, tmpDir, toc, writeTree } from './helpers.js';
import { update, uninstall, inspect, treeStats } from '../src/app.js';
import { saveConfig, loadConfig, DEFAULT_CONFIG, loadState, saveState, stateKey } from '../src/config.js';
import { validate, loadCustom, addCustom, removeCustom, checkNew } from '../src/custom.js';
import { GitHubSource } from '../src/sources/github.js';
import { addFromGitHub } from '../src/addrepo.js';
import { runMenu } from '../src/menu.js';
import { main } from '../src/cli.js';
import { swapIn } from '../src/swap.js';

/**
 * Same fake world as custom.test.js: AddOns with Details, a config, and a fake source keyed by item id
 * (or "id@version" for pinned requests) serving zips from a local server.
 * @param {Record<string, { version: string, files: Record<string, string> }>} table
 * @param {Partial<import('../src/config.js').Config>} [config]
 */
async function world(table, config = {}) {
  const home = tmpDir();
  const addons = path.join(home, 'wow', '_classic_beta_', 'Interface', 'AddOns');
  writeTree(addons, { 'Details/Details.toc': toc('1.0.0') });
  const configDir = path.join(home, 'config');
  saveConfig(configDir, { ...DEFAULT_CONFIG, addons_path: addons, ...config });
  /** @type {Record<string, Buffer>} */
  const files = {};
  for (const [key, u] of Object.entries(table)) files[`/${key}.zip`] = makeZip(u.files);
  const srv = await serve(files);
  /** @type {import('../src/sources/source.js').Source} */
  const source = {
    name: 'Fake',
    async latest(item) {
      const key = item.pin ? `${item.id}@${item.pin}` : item.id;
      const u = table[key];
      if (!u) {
        if (item.pin) throw new Error(`version ${item.pin} was not found`);
        return null;
      }
      const body = files[`/${key}.zip`];
      return { version: u.version, tag: `v${u.version}`, source: 'Fake', asset: { name: `${item.id}-${u.version}.zip`, url: `${srv.url}/${key}.zip`, size: body.length, sha256: sha256(body) } };
    },
  };
  return { home, addons, configDir, srv, deps: { source, configDir, cacheDir: path.join(home, 'cache'), runningWow: () => [], tty: false } };
}

const NS = (/** @type {string} */ v) => ({ version: v, files: { 'NodeSight/NodeSight.toc': toc(v), 'NodeSight/NodeSight.lua': `ns ${v}` } });
const COOL = (/** @type {string} */ v) => ({ version: v, files: { 'CoolAddon/CoolAddon.toc': toc(v), 'CoolAddon/Core.lua': `core ${v}` } });

/** @param {string} dir @param {object[]} addons */
const writeAddonsJson = (dir, addons) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'addons.json'), JSON.stringify({ addons }));
};

/** Answers a script of lines to prompts. @param {string[]} answers */
function scripted(answers) {
  const input = /** @type {any} */ (new PassThrough());
  const output = /** @type {any} */ (new PassThrough());
  output.resume();
  /** @type {import('../src/tui.js').IO} */
  const io = { input, output, ask: async (q) => {
    const a = answers.shift();
    if (a === undefined) throw new Error(`unexpected question: ${q}`);
    return a;
  } };
  return { io, left: () => answers.length };
}

test('the install itself re-checks for a developer copy that appears after planning', async () => {
  const w = await world({ nodesight: NS('1.4.1') }, { selected: ['nodesight'] });
  try {
    writeTree(w.addons, { 'NodeSight/NodeSight.toc': toc('1.0.0'), 'NodeSight/NodeSight.lua': 'mine' });
    // runningWow is asked after planning and before installing: the folder becomes a git checkout in between.
    const deps = { ...w.deps, runningWow: () => { fs.mkdirSync(path.join(w.addons, 'NodeSight', '.git'), { recursive: true }); return []; } };
    assert.equal(await update({ yes: true }, deps), 1, 'refused');
    assert.equal(fs.readFileSync(path.join(w.addons, 'NodeSight/NodeSight.lua'), 'utf8'), 'mine');
  } finally {
    await w.srv.close();
  }
});

test('an addon that was added but never installed, or whose folders are gone, can still be removed', async () => {
  const w = await world({ 'cool-addon': COOL('1.0.0'), nodesight: NS('1.4.1') }, { selected: ['nodesight', 'cool-addon'], pinned: { 'cool-addon': '1.0.0' } });
  try {
    writeAddonsJson(w.configDir, [{ repo: 'me/Cool-Addon', folders: ['CoolAddon'] }]);
    assert.equal(await uninstall({ only: ['cool-addon'], yes: true }, w.deps), 0);
    assert.deepEqual(loadCustom(w.configDir).entries, []);
    assert.deepEqual(loadConfig(w.configDir).selected, ['nodesight']);
    assert.deepEqual(loadConfig(w.configDir).pinned, {}, 'its pin goes too');

    assert.equal(await update({ yes: true, only: ['nodesight'] }, w.deps), 0);
    fs.rmSync(path.join(w.addons, 'NodeSight'), { recursive: true });
    assert.equal(await uninstall({ only: ['nodesight'], yes: true }, w.deps), 0);
    assert.deepEqual(loadState(w.configDir).installs[stateKey(w.addons)], {}, 'forgotten even though the folder was already gone');
    assert.equal(await uninstall({ only: ['nodesight'], yes: true }, w.deps), 0, 'and a second time is a no-op');
  } finally {
    await w.srv.close();
  }
});

test('remove works from the state as it is when the lock is taken, not as it was when asked', async () => {
  const w = await world({ nodesight: NS('1.4.1') }, { selected: ['nodesight'] });
  try {
    assert.equal(await update({ yes: true }, w.deps), 0);
    const key = stateKey(w.addons);
    const deps = { ...w.deps, tty: true, ask: async () => {
      // Another run records a second folder for the addon while the question is on screen.
      writeTree(w.addons, { 'NodeSight/Extra/Extra.toc': toc('1.4.1') });
      const st = loadState(w.configDir);
      st.installs[key].other = { tag: 't', version: '1', asset: 'a', sha256: null, installedAt: '', folders: { Other: { files: 1, bytes: 1, tocVersion: '1' } } };
      saveState(w.configDir, st);
      return 'y';
    } };
    assert.equal(await uninstall({ only: ['nodesight'] }, deps), 0);
    assert.ok(!fs.existsSync(path.join(w.addons, 'NodeSight')));
    assert.ok(loadState(w.configDir).installs[stateKey(w.addons)].other, 'the other run\'s record survived');
  } finally {
    await w.srv.close();
  }
});

test('custom ids cannot take the names of the retired Spoken 2.x items', () => {
  const { entries, problems } = validate([{ repo: 'me/Quests', folders: ['Quests'] }, { repo: 'me/Player', folders: ['Player'], id: 'player' }]);
  assert.deepEqual(entries, []);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /already in use/);
});

test('removing Spoken also takes any retired 2.x install', async () => {
  const w = await world({});
  try {
    writeTree(w.addons, { 'SpokenPlayer/SpokenPlayer.toc': toc('2.3.2') });
    const rec = { tag: 't', version: '2.3.2', asset: 'a', sha256: null, installedAt: '', folders: { SpokenPlayer: { files: 1, bytes: 1, tocVersion: '2.3.2' } } };
    saveState(w.configDir, { schema: 1, installs: { [stateKey(w.addons)]: { player: rec } } });
    assert.equal(await uninstall({ only: ['spoken'], yes: true }, w.deps), 0);
    assert.ok(!fs.existsSync(path.join(w.addons, 'SpokenPlayer')));
  } finally {
    await w.srv.close();
  }
});

test('an in-use LINK is never emptied through: the swap gives up instead', (t) => {
  const root = tmpDir();
  const addons = path.join(root, 'Interface', 'AddOns');
  const checkout = path.join(root, 'checkout', 'Thing');
  writeTree(path.dirname(checkout), { 'Thing/Thing.toc': toc('1.0.0'), 'Thing/work.lua': 'precious' });
  fs.mkdirSync(addons, { recursive: true });
  try {
    fs.symlinkSync(checkout, path.join(addons, 'Thing'), 'junction');
  } catch {
    return t.skip('cannot create a link here');
  }
  const rename = (/** @type {string} */ a, /** @type {string} */ b) => {
    if (path.resolve(a) === path.join(addons, 'Thing')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY', path: a });
    fs.renameSync(a, b);
  };
  assert.throws(() => swapIn({ addons, roots: [], remove: ['Thing'], workDir: path.join(root, 'Interface', '.w'), rename }), /in use by another program/);
  assert.equal(fs.readFileSync(path.join(checkout, 'work.lua'), 'utf8'), 'precious');
});

test('--pin is only kept when the install worked', async () => {
  const w = await world({ nodesight: NS('1.4.1'), 'nodesight@1.4.0': NS('1.4.0') }, { selected: ['nodesight'] });
  try {
    const run = (/** @type {string[]} */ a) => main([...a, '--yes', '--no-self-update'], { interactive: false, deps: w.deps });
    await assert.rejects(run(['install', '--only', 'nodsight', '--pin', '1.4.0']), /unknown item/);
    assert.deepEqual(loadConfig(w.configDir).pinned, {}, 'a typo leaves nothing behind');
    assert.equal(await run(['install', '--only', 'nodesight', '--pin', '9.9.9']), 1);
    assert.deepEqual(loadConfig(w.configDir).pinned, {}, 'a version that does not exist is not kept');
    assert.equal(await main(['install', '--only', 'nodesight', '--pin', '1.4.0', '--dry-run', '--yes'], { interactive: false, deps: w.deps }), 0);
    assert.deepEqual(loadConfig(w.configDir).pinned, {}, 'nor on a dry run');
    assert.equal(await run(['install', '--only', 'nodesight', '--pin', '1.4.0']), 0);
    assert.deepEqual(loadConfig(w.configDir).pinned, { nodesight: '1.4.0' });
    assert.equal(await run(['install', '--only', 'nodesight', '--unpin']), 0);
    assert.deepEqual(loadConfig(w.configDir).pinned, {});
  } finally {
    await w.srv.close();
  }
});

test('hand-edited addons.json shapes cannot crash or corrupt it', () => {
  const dir = tmpDir();
  for (const bad of ['{"addons": {"repo": "a/b"}}', '{"addons": "abc"}']) {
    fs.writeFileSync(path.join(dir, 'addons.json'), bad);
    assert.deepEqual(loadCustom(dir).entries, []);
    assert.match(loadCustom(dir).problems[0], /must be a list/);
    assert.match(checkNew(dir, { id: 'x', repo: 'a/b', folders: ['X'] }) ?? '', /must be a list/);
    assert.throws(() => addCustom(dir, { id: 'x', repo: 'a/b', folders: ['X'] }), /must be a list/);
    assert.throws(() => removeCustom(dir, 'x'), /must be a list/);
    assert.equal(fs.readFileSync(path.join(dir, 'addons.json'), 'utf8'), bad, 'untouched');
  }
});

test('plain-tag repos fall back to the full list when the newest page has no usable zip', async () => {
  const rel = (/** @type {string} */ tag, /** @type {string[]} */ names) => ({ tag_name: tag, draft: false, prerelease: false, assets: names.map((n) => ({ name: n, size: 5, browser_download_url: `https://x/${n}`, digest: null })) });
  /** @type {string[]} */
  const urls = [];
  /** @type {any} */
  const fetchImpl = async (/** @type {string} */ url) => {
    urls.push(url);
    const newest = [rel('v2.0.0', ['Cool-2.0.0-classic.zip'])];
    return new Response(JSON.stringify(url.includes('per_page=30') ? newest : [...newest, rel('v1.0.0', ['Cool-1.0.0-retail.zip'])]), { status: 200 });
  };
  const src = new GitHubSource({ repo: 'o/r', fetchImpl });
  const r = await src.latest(/** @type {any} */ ({ id: 'cool', tagMode: 'plain', assetPrefix: 'Cool', assetPattern: /retail/i }));
  assert.equal(r?.version, '1.0.0');
  assert.equal(urls.length, 2);
});

test('add --dry-run saves nothing', async () => {
  const w = await world({ 'cool-addon': COOL('1.0.0') });
  try {
    assert.equal(await addFromGitHub('me/cool-addon', { dryRun: true, yes: true }, w.deps, scripted([]).io), null);
    assert.ok(!fs.existsSync(path.join(w.configDir, 'addons.json')));
  } finally {
    await w.srv.close();
  }
});

test('adding inspects the zip the install will pick when a release has several', async () => {
  const home = tmpDir();
  const configDir = path.join(home, 'config');
  saveConfig(configDir, { ...DEFAULT_CONFIG, addons_path: path.join(home, 'AddOns') });
  const other = makeZip({ 'Other/Other.toc': toc('1.0.0') });
  const real = makeZip({ 'Cool/Cool.toc': toc('1.0.0'), 'Cool/pad.lua': 'x'.repeat(5000) });
  const srv = await serve({ '/other.zip': other, '/real.zip': real });
  try {
    const mk = (/** @type {string} */ name, /** @type {string} */ file, /** @type {Buffer} */ body) => ({ name, url: `${srv.url}/${file}.zip`, size: body.length, sha256: sha256(body) });
    // Without a name hint the release picks "other"; with the addon folder's name as the hint it picks "real".
    const source = { name: 'Fake', async latest(/** @type {any} */ item) {
      const asset = item.assetPrefix === 'Cool' ? mk('Cool-1.0.0.zip', 'real', real) : mk('Other-1.0.0.zip', 'other', other);
      return { version: '1.0.0', tag: 'v1.0.0', source: 'Fake', asset };
    } };
    const deps = { source, configDir, cacheDir: path.join(home, 'cache'), runningWow: () => [], tty: false };
    // The first look finds Other; the second, with that folder as the hint, finds nothing different, so it stays.
    const r = await addFromGitHub('me/cool', { yes: true }, deps, scripted([]).io);
    assert.equal(r?.id, 'cool');
    assert.ok(loadCustom(configDir).entries[0].folders.length === 1);
  } finally {
    await srv.close();
  }
});

test('menu: choosing addons while addons.json is broken keeps the custom ones selected', async () => {
  const w = await world({}, { selected: ['nodesight', 'cool-addon'] });
  try {
    fs.writeFileSync(path.join(w.configDir, 'addons.json'), '{ broken');
    const s = scripted(['2', '', '6']); // Choose addons > confirm as it is > Quit
    await runMenu({}, w.deps, s.io);
    assert.ok(loadConfig(w.configDir).selected.includes('cool-addon'));
  } finally {
    await w.srv.close();
  }
});

test('a pin works with letter suffixes: 1.0.5-f installed, pinned to 1.0.5, is a move back', () => {
  const dir = tmpDir();
  writeTree(dir, { 'D/D.toc': toc('1.0.5'), 'D/code.lua': 'x' });
  const item = /** @type {any} */ ({ id: 'd', owns: () => true, folders: ['D'], letterSuffix: true, pin: '1.0.5' });
  const rel = (/** @type {string} */ v) => /** @type {any} */ ({ version: v, tag: `v${v}`, asset: { name: `D-${v}.zip` } });
  const st = /** @type {any} */ ({ tag: 'v1.0.5-f', version: '1.0.5-f', folders: { D: { ...treeStats(path.join(dir, 'D')), tocVersion: '1.0.5' } } });
  assert.equal(inspect(item, rel('1.0.5'), dir, st).status, 'outdated', 'the recorded tag differs, so install the pinned one');
  assert.equal(inspect({ ...item, pin: undefined }, rel('1.0.5-f'), dir, st).status, 'current', 'without a pin the recorded tag matches');
});
