// @ts-check
// Custom addons (addons.json), adding from GitHub, removing, developer-copy protection,
// pinned versions and release notes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { makeZip, serve, sha256, snapshot, tmpDir, toc, writeTree } from './helpers.js';
import { update, makePlan, uninstall, inspect } from '../src/app.js';
import { saveConfig, loadConfig, DEFAULT_CONFIG, loadState, saveState, stateKey } from '../src/config.js';
import { parseRepo, slug, validate, loadCustom, addCustom, removeCustom, checkNew } from '../src/custom.js';
import { zipAddonFolders } from '../src/extract.js';
import { pickAsset, GitHubSource } from '../src/sources/github.js';
import { buildCatalog } from '../src/catalog.js';
import { addFromGitHub } from '../src/addrepo.js';
import { summarizeNotes } from '../src/notes.js';
import { devCopyReason } from '../src/platform.js';
import { runMenu } from '../src/menu.js';

/**
 * A fake world: AddOns with Details and WTF next to it, a config, and a fake release source
 * serving zips from a local server. Table keys are item ids, or "id@version" for pinned requests.
 * @param {Record<string, { version: string, tag?: string, asset?: string, notes?: string, files: Record<string, string> }>} table
 * @param {Partial<import('../src/config.js').Config>} [config]
 */
async function world(table, config = {}) {
  const home = tmpDir();
  const addons = path.join(home, 'wow', '_classic_beta_', 'Interface', 'AddOns');
  writeTree(addons, { 'Details/Details.toc': toc('1.0.0'), 'Details/Details.lua': 'keep me' });
  writeTree(path.join(home, 'wow', '_classic_beta_', 'WTF'), { 'Account/X/SavedVariables/Cool.lua': 'settings' });
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
      return { version: u.version, tag: u.tag ?? `v${u.version}`, notes: u.notes, source: 'Fake',
        asset: { name: u.asset ?? `${item.id}-${u.version}.zip`, url: `${srv.url}/${key}.zip`, size: body.length, sha256: sha256(body) } };
    },
  };
  const deps = { source, configDir, cacheDir: path.join(home, 'cache'), runningWow: () => [], tty: false };
  return { home, addons, configDir, srv, deps };
}

const COOL = (/** @type {string} */ v) => ({ version: v, files: { 'CoolAddon/CoolAddon.toc': toc(v), 'CoolAddon/Core.lua': `core ${v}` } });
const NS = (/** @type {string} */ v, /** @type {string} */ notes = '') => ({ version: v, notes, files: { 'NodeSight/NodeSight.toc': toc(v), 'NodeSight/NodeSight.lua': `ns ${v}` } });

/** @param {string} configDir @param {object[]} addons */
const writeAddonsJson = (configDir, addons) => {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'addons.json'), JSON.stringify({ addons }));
};

/** Answers a script of lines to prompts; fails on an unexpected question. @param {string[]} answers */
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

// ---- addons.json ----

test('parseRepo and slug understand the ways people write a repo', () => {
  for (const t of ['owner/name', 'https://github.com/owner/name', 'github.com/owner/name', 'https://www.github.com/owner/name/', 'https://github.com/owner/name.git',
    'https://github.com/owner/name/releases/latest', 'git@x', '  owner/name  ']) {
    assert.equal(parseRepo(t), t === 'git@x' ? null : 'owner/name', t);
  }
  for (const t of ['', 'name', 'a/b/c', 'https://example.com/owner/name', '../x', './.']) assert.equal(parseRepo(t), null, t);
  assert.equal(slug('Krelock/Node_Sight'), 'node-sight');
});

test('validate accepts good entries and explains every bad one without throwing', () => {
  const good = { repo: 'me/Cool-Addon', folders: ['CoolAddon', 'CoolAddon_Options'], title: 'Cool', letter_suffix: true, asset: 'retail' };
  const { entries, problems } = validate([
    good,
    { repo: 'nonsense', folders: ['X'] },
    { repo: 'me/a', folders: [] },
    { repo: 'me/b', folders: ['../Evil'] },
    { repo: 'me/c', folders: ['Blizzard_Foo'] },
    { repo: 'me/d', folders: ['NodeSight'] },
    { repo: 'me/e', folders: ['SpokenThing'] },
    { repo: 'me/f', folders: ['Fine'], id: 'nodesight' },
    { repo: 'me/g', folders: ['Fine'], id: 'quests-audio-x' },
    { repo: 'me/h', folders: ['Fine'], asset: '(' },
    { repo: 'me/i', folders: ['coolADDON'] },
    null,
    'text',
  ]);
  assert.deepEqual(entries.map((e) => e.id), ['cool-addon']);
  assert.deepEqual(entries[0].folders, ['CoolAddon', 'CoolAddon_Options']);
  assert.equal(entries[0].letterSuffix, true);
  assert.equal(problems.length, 12);
  const text = problems.join('\n');
  for (const frag of ['owner/name', '"folders"', 'plain folder name', 'belongs to the game', 'already built into this tool', 'already managed by Spoken',
    'already in use', 'not a valid pattern', 'already managed by']) assert.ok(text.includes(frag), frag);
  assert.deepEqual(validate('nope').entries, []);
});

test('a broken addons.json never stops the tool, and is never overwritten', async () => {
  const w = await world({ nodesight: NS('1.4.1') }, { selected: ['nodesight'] });
  try {
    fs.writeFileSync(path.join(w.configDir, 'addons.json'), '{ "addons": [ oops');
    const loaded = loadCustom(w.configDir);
    assert.deepEqual(loaded.entries, []);
    assert.match(loaded.problems[0], /not valid JSON/);
    const { plans, problems } = await makePlan({}, w.deps);
    assert.deepEqual(plans.map((p) => p.item.id), ['nodesight']);
    assert.equal(problems.length, 1);
    assert.throws(() => addCustom(w.configDir, { id: 'x', repo: 'a/b', folders: ['X'] }), /not valid JSON/);
    assert.equal(fs.readFileSync(path.join(w.configDir, 'addons.json'), 'utf8'), '{ "addons": [ oops', 'left exactly as it was');
  } finally {
    await w.srv.close();
  }
});

test('addCustom and removeCustom keep what else is in the file', () => {
  const dir = tmpDir();
  writeAddonsJson(dir, [{ repo: 'me/one', folders: ['One'], note: 'hand written' }]);
  addCustom(dir, { id: 'two', repo: 'me/two', folders: ['Two'] });
  assert.deepEqual(loadCustom(dir).entries.map((e) => e.id), ['one', 'two']);
  removeCustom(dir, 'one'); // the id derived from the repo
  const left = JSON.parse(fs.readFileSync(path.join(dir, 'addons.json'), 'utf8'));
  assert.deepEqual(left.addons.map((/** @type {any} */ a) => a.repo), ['me/two']);
  assert.equal(checkNew(dir, { id: 'two', repo: 'me/two', folders: ['Two'] }) !== null, true, 'duplicate id refused');
  assert.equal(checkNew(dir, { id: 'three', repo: 'me/three', folders: ['Three'] }), null);
});

// ---- the zip and the release source ----

test('zipAddonFolders finds addon folders however the zip is laid out', async () => {
  const dir = tmpDir();
  /** @param {string} name @param {Record<string, string>} files */
  const zip = (name, files) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, makeZip(files));
    return f;
  };
  assert.deepEqual(await zipAddonFolders(zip('a.zip', { 'A/A.toc': 'x', 'A/a.lua': 'x', 'A_Opts/A_Opts.toc': 'x' })), ['A', 'A_Opts']);
  assert.deepEqual(await zipAddonFolders(zip('b.zip', { 'repo-main/B/B.toc': 'x', 'repo-main/README.md': 'x' })), ['B'], 'wrapper folder');
  assert.deepEqual(await zipAddonFolders(zip('c.zip', { 'C.toc': 'x', 'c.lua': 'x' })), ['C'], 'flat zip');
  assert.deepEqual(await zipAddonFolders(zip('d.zip', { 'D/D-Mainline.toc': 'x' })), ['D'], 'flavor-suffixed .toc');
  assert.deepEqual(await zipAddonFolders(zip('e.zip', { 'Other/Different.toc': 'x', 'readme.txt': 'x' })), [], 'toc of another name');
});

test('an asset pattern picks the right zip, and says so when none matches', () => {
  const assets = ['Cool-1.0.0.zip', 'Cool-1.0.0-classic.zip', 'Cool-1.0.0-bcc.zip'].map((name, i) => ({ name, size: 100 + i, browser_download_url: `https://x/${name}` }));
  assert.equal(pickAsset(assets, 'Cool', '1.0.0', /classic/i).name, 'Cool-1.0.0-classic.zip');
  assert.equal(pickAsset(assets, 'Cool', '1.0.0', /^Cool-[\d.]+\.zip$/).name, 'Cool-1.0.0.zip');
  assert.throws(() => pickAsset(assets, 'Cool', '1.0.0', /wotlk/), /matching \/wotlk\//);
});

test('a pinned version is that release; a missing one is a clear error', async () => {
  const rel = (/** @type {string} */ tag) => ({ tag_name: tag, draft: false, prerelease: false, body: `notes for ${tag}`, assets: [{ name: `D-${tag}.zip`, size: 5, browser_download_url: `https://x/${tag}`, digest: null }] });
  /** @type {any} */
  const fetchImpl = async () => new Response(JSON.stringify([rel('v1.0.6'), rel('v1.0.5-f'), rel('v1.0.5-b'), rel('v1.0.5')]), { status: 200 });
  const src = new GitHubSource({ repo: 'o/r', fetchImpl });
  const base = { id: 'd', tagMode: 'plain', letterSuffix: true, assetPrefix: 'D' };
  assert.equal((await src.latest(/** @type {any} */ ({ ...base }))).version, '1.0.6');
  assert.equal((await src.latest(/** @type {any} */ ({ ...base, pin: '1.0.5-b' }))).tag, 'v1.0.5-b');
  assert.equal((await src.latest(/** @type {any} */ ({ ...base, pin: '1.0.5' }))).version, '1.0.5');
  assert.equal((await src.latest(/** @type {any} */ ({ ...base }))).notes, 'notes for v1.0.6', 'release notes come along');
  await assert.rejects(src.latest(/** @type {any} */ ({ ...base, pin: '9.9.9' })), /9\.9\.9 was not found/);
});

// ---- installing custom addons ----

test('a custom addon installs only the folders it declared, then settles', async () => {
  const sneaky = { version: '1.0.0', files: { ...COOL('1.0.0').files, 'Details/Details.toc': toc('9.9.9'), 'Details/Details.lua': 'overwritten', 'Blizzard_Evil/Blizzard_Evil.toc': toc('1.0.0') } };
  const w = await world({ 'cool-addon': sneaky }, { selected: ['cool-addon'] });
  try {
    writeAddonsJson(w.configDir, [{ repo: 'me/Cool-Addon', folders: ['CoolAddon'], title: 'Cool Addon' }]);
    assert.equal(await update({ yes: true }, w.deps), 0);
    assert.deepEqual(fs.readdirSync(w.addons).sort(), ['CoolAddon', 'Details']);
    assert.equal(fs.readFileSync(path.join(w.addons, 'Details/Details.lua'), 'utf8'), 'keep me');
    const before = snapshot(w.home);
    const requests = w.srv.stats.requests;
    assert.equal(await update({ yes: true }, w.deps), 0);
    assert.equal(w.srv.stats.requests, requests);
    assert.deepEqual(snapshot(w.home), before, 'second run changes nothing');
  } finally {
    await w.srv.close();
  }
});

test('catalog: custom addons are in it when selected, and carry their pattern and pin', () => {
  const custom = validate([{ repo: 'me/Cool-Addon', folders: ['CoolAddon'], asset: 'retail' }]).entries;
  const ids = (/** @type {any} */ o) => buildCatalog({ language: 'enUS', includeZones: true, includeBooks: true, ...o }).map((i) => i.id);
  assert.deepEqual(ids({ custom, selected: ['cool-addon'] }), ['cool-addon']);
  assert.ok(ids({ custom }).includes('cool-addon'), 'no selection means everything');
  assert.ok(!ids({ custom, selected: ['nodesight'] }).includes('cool-addon'));
  const [item] = buildCatalog({ language: 'enUS', includeZones: true, includeBooks: true, custom, selected: ['cool-addon'], pinned: { 'cool-addon': '1.0.0' } });
  assert.equal(item.pin, '1.0.0');
  assert.ok(item.assetPattern?.test('Cool-retail.zip'));
  assert.equal(item.owns('coolADDON'), true);
  assert.equal(item.owns('Details'), false);
});

// ---- adding from GitHub ----

test('adding from GitHub reads the folders from the zip and saves the addon', async () => {
  const w = await world({ 'cool-addon': COOL('1.0.0') }, { selected: ['nodesight'] });
  try {
    const s = scripted(['1', '2']); // Add it: yes; install now: no
    const r = await addFromGitHub('https://github.com/me/Cool-Addon', {}, w.deps, s.io);
    assert.deepEqual(r, { id: 'cool-addon', installNow: false });
    const [e] = loadCustom(w.configDir).entries;
    assert.deepEqual([e.id, e.repo, e.folders], ['cool-addon', 'me/Cool-Addon', ['CoolAddon']]);
    assert.ok(loadConfig(w.configDir).selected.includes('cool-addon'));
    assert.equal(s.left(), 0);
    // The zip it looked inside is reused by the install: no second download.
    const requests = w.srv.stats.requests;
    assert.equal(await update({ yes: true, only: ['cool-addon'] }, w.deps), 0);
    assert.equal(w.srv.stats.requests, requests);
    assert.ok(fs.existsSync(path.join(w.addons, 'CoolAddon/CoolAddon.toc')));
  } finally {
    await w.srv.close();
  }
});

test('adding is refused for unusable repos, and saying no leaves nothing behind', async () => {
  const w = await world({
    'bad-zip': { version: '1.0.0', files: { 'readme.txt': 'no addon here' } },
    'dup': { version: '1.0.0', files: { 'NodeSight/NodeSight.toc': toc('1.0.0') } },
    'cool-addon': COOL('1.0.0'),
  });
  try {
    await assert.rejects(addFromGitHub('not a repo', {}, w.deps, scripted([]).io), /does not look like a GitHub address/);
    await assert.rejects(addFromGitHub('me/nothing-here', {}, w.deps, scripted([]).io), /no release with a \.zip/);
    await assert.rejects(addFromGitHub('me/bad-zip', {}, w.deps, scripted([]).io), /no addon folder/);
    await assert.rejects(addFromGitHub('me/dup', {}, w.deps, scripted([]).io), /already built into this tool/);
    assert.equal(await addFromGitHub('me/cool-addon', {}, w.deps, scripted(['2']).io), null, 'no');
    assert.ok(!fs.existsSync(path.join(w.configDir, 'addons.json')));
    assert.ok(!fs.existsSync(path.join(w.deps.cacheDir, 'downloads', 'cool-addon')), 'the looked-at zip is discarded');
  } finally {
    await w.srv.close();
  }
});

// ---- developer copies ----

test('a folder with .git or a link is a developer copy and is left alone unless asked', async () => {
  const w = await world({ nodesight: NS('1.4.1') }, { selected: ['nodesight'] });
  try {
    writeTree(w.addons, { 'NodeSight/NodeSight.toc': toc('1.0.0'), 'NodeSight/NodeSight.lua': 'my work', 'NodeSight/.git/HEAD': 'ref' });
    assert.match(devCopyReason(w.addons, 'NodeSight') ?? '', /\.git/);
    const [p] = (await makePlan({}, w.deps)).plans;
    assert.equal(p.status, 'dev');
    assert.equal(p.act, false);
    assert.equal(await update({ yes: true }, w.deps), 0);
    assert.equal(fs.readFileSync(path.join(w.addons, 'NodeSight/NodeSight.lua'), 'utf8'), 'my work', 'untouched');
    assert.equal((await makePlan({ only: ['nodesight'] }, w.deps)).plans[0].act, false, 'even --only does not override it');

    assert.equal(await update({ yes: true, only: ['nodesight'], overwriteDev: true }, w.deps), 0);
    assert.equal(fs.readFileSync(path.join(w.addons, 'NodeSight/NodeSight.lua'), 'utf8'), 'ns 1.4.1');
  } finally {
    await w.srv.close();
  }
});

test('a linked folder is a developer copy, and the install refuses it even if planning missed it', async (t) => {
  const w = await world({ nodesight: NS('1.4.1') }, { selected: ['nodesight'] });
  try {
    const target = path.join(w.home, 'checkout', 'NodeSight');
    writeTree(path.dirname(target), { 'NodeSight/NodeSight.toc': toc('1.0.0') });
    try {
      fs.symlinkSync(target, path.join(w.addons, 'NodeSight'), 'junction');
    } catch {
      return t.skip('cannot create a link here');
    }
    assert.match(devCopyReason(w.addons, 'NodeSight') ?? '', /link/);
    assert.equal(await update({ yes: true }, w.deps), 0);
    assert.equal(fs.readFileSync(path.join(target, 'NodeSight.toc'), 'utf8'), toc('1.0.0'), 'the checkout is untouched');
  } finally {
    await w.srv.close();
  }
});

// ---- pinning ----

test('pinning holds a version, and rolls back to it', async () => {
  const w = await world({ nodesight: NS('1.4.1'), 'nodesight@1.4.0': NS('1.4.0') }, { selected: ['nodesight'] });
  try {
    assert.equal(await update({ yes: true }, w.deps), 0);
    assert.match(fs.readFileSync(path.join(w.addons, 'NodeSight/NodeSight.lua'), 'utf8'), /1\.4\.1/);

    saveConfig(w.configDir, { ...loadConfig(w.configDir), pinned: { nodesight: '1.4.0' } });
    const [p] = (await makePlan({}, w.deps)).plans;
    assert.equal(p.status, 'outdated');
    assert.match(p.reason, /1\.4\.1 -> 1\.4\.0 \(pinned\)/, 'a pin may go backwards');
    assert.equal(await update({ yes: true }, w.deps), 0);
    assert.match(fs.readFileSync(path.join(w.addons, 'NodeSight/NodeSight.lua'), 'utf8'), /1\.4\.0/);
    assert.equal((await makePlan({}, w.deps)).plans[0].status, 'current', 'held, nothing to do');

    saveConfig(w.configDir, { ...loadConfig(w.configDir), pinned: { nodesight: '9.9.9' } });
    const bad = (await makePlan({}, w.deps)).plans[0];
    assert.equal(bad.status, 'error');
    assert.match(bad.reason, /9\.9\.9 was not found/);
  } finally {
    await w.srv.close();
  }
});

// ---- removing ----

test('remove deletes only that addon, keeps WTF, and forgets it', async () => {
  const w = await world({ nodesight: NS('1.4.1'), 'cool-addon': COOL('1.0.0') }, { selected: ['nodesight', 'cool-addon'] });
  try {
    writeAddonsJson(w.configDir, [{ repo: 'me/Cool-Addon', folders: ['CoolAddon'] }]);
    assert.equal(await update({ yes: true }, w.deps), 0);
    const wtf = snapshot(path.join(w.home, 'wow', '_classic_beta_', 'WTF'));

    await assert.rejects(uninstall({ only: ['nodesight'] }, w.deps), /needs --yes/, 'no terminal to ask in');
    await assert.rejects(uninstall({ only: ['nope'], yes: true }, w.deps), /unknown addon/);
    await assert.rejects(uninstall({ only: ['nodesight'], yes: true }, { ...w.deps, runningWow: () => ['Wow.exe'] }), /is running/);
    assert.ok(fs.existsSync(path.join(w.addons, 'NodeSight')));

    assert.equal(await uninstall({ only: ['nodesight', 'cool-addon'], yes: true }, w.deps), 0);
    assert.deepEqual(fs.readdirSync(w.addons), ['Details']);
    assert.deepEqual(snapshot(path.join(w.home, 'wow', '_classic_beta_', 'WTF')), wtf, 'settings are kept');
    assert.deepEqual(loadState(w.configDir).installs[stateKey(w.addons)], {});
    assert.deepEqual(loadConfig(w.configDir).selected, [], 'not selected any more, so it will not come back');
    assert.deepEqual(loadCustom(w.configDir).entries, [], 'the custom entry is gone');
    assert.ok(!fs.existsSync(path.join(w.addons, '..', '.wow-forever-essentals-updater')), 'work dir cleaned up');
    assert.equal(await uninstall({ only: ['nodesight'], yes: true }, w.deps), 0, 'removing twice is fine');
  } finally {
    await w.srv.close();
  }
});

test('removing Spoken takes the addon and every voice pack, nothing else', async () => {
  const w = await world({});
  try {
    writeTree(w.addons, {
      'Spoken/Spoken.toc': toc('3.0.0'), 'Spoken_Quests/Spoken_Quests.toc': toc('3.0.0'),
      'SpokenQuestsAudioAlliance/SpokenQuestsAudioAlliance.toc': toc('2.0.0'), 'SpokenQuestsAudio_frFR/SpokenQuestsAudio_frFR.toc': toc('0.1.0'),
    });
    const rec = (/** @type {string[]} */ names) => ({ tag: 't', version: '1', asset: 'a', sha256: null, installedAt: '', folders: Object.fromEntries(names.map((n) => [n, { files: 1, bytes: 1, tocVersion: '1' }])) });
    saveState(w.configDir, { schema: 1, installs: { [stateKey(w.addons)]: {
      spoken: rec(['Spoken', 'Spoken_Quests']), 'quests-audio': rec(['SpokenQuestsAudioAlliance']), 'quests-audio-frFR': rec(['SpokenQuestsAudio_frFR']),
    } } });
    assert.equal(await uninstall({ only: ['spoken'], yes: true }, w.deps), 0);
    assert.deepEqual(fs.readdirSync(w.addons), ['Details']);
    assert.deepEqual(loadState(w.configDir).installs[stateKey(w.addons)], {});
  } finally {
    await w.srv.close();
  }
});

test('remove refuses a developer copy, and an in-use folder restores everything', async () => {
  const w = await world({ nodesight: NS('1.4.1') }, { selected: ['nodesight'] });
  try {
    assert.equal(await update({ yes: true }, w.deps), 0);
    writeTree(w.addons, { 'NodeSight/.git/HEAD': 'x' });
    assert.equal(await uninstall({ only: ['nodesight'], yes: true }, w.deps), 1);
    assert.ok(fs.existsSync(path.join(w.addons, 'NodeSight/NodeSight.toc')), 'kept');
    assert.equal(await uninstall({ only: ['nodesight'], yes: true, overwriteDev: true, dryRun: true }, w.deps), 0);
    assert.ok(fs.existsSync(path.join(w.addons, 'NodeSight')), 'dry run changes nothing');
    assert.equal(await uninstall({ only: ['nodesight'], yes: true, overwriteDev: true }, w.deps), 0);
    assert.ok(!fs.existsSync(path.join(w.addons, 'NodeSight')));
  } finally {
    await w.srv.close();
  }
});

// ---- notes ----

test('release notes are boiled down to a few plain lines', () => {
  const body = [
    "## What's Changed", '* Fix the **minimap** arrow by @someone in https://github.com/o/r/pull/12', '* Add [new icons](https://x/y) for herbs',
    '- Plain bullet with `code`', '', '![shot](https://x/s.png)', '', '**Full Changelog**: https://github.com/o/r/compare/v1...v2',
    '## New Contributors', '* @someone made their first contribution',
  ].join('\n');
  assert.deepEqual(summarizeNotes(body), ['Fix the minimap arrow', 'Add new icons for herbs', 'Plain bullet with code']);
  assert.deepEqual(summarizeNotes(''), []);
  assert.deepEqual(summarizeNotes(null), []);
  const many = Array.from({ length: 9 }, (_, i) => `line ${i}`).join('\n');
  const out = summarizeNotes(many, { lines: 3 });
  assert.equal(out.length, 4);
  assert.match(out[3], /and 6 more/);
  assert.ok(summarizeNotes('x'.repeat(300), { width: 40 })[0].length <= 40);
});

// ---- the menu ----

test('menu: adding and removing an addon', async () => {
  const w = await world({ 'cool-addon': COOL('1.0.0') }, { selected: ['nodesight'] });
  try {
    // Add or remove > Add > address > yes, add > no, not now > Enter > Quit
    const s = scripted(['3', '1', 'me/cool-addon', '1', '2', '', '6']);
    assert.equal(await runMenu({ yes: false }, w.deps, s.io), 0);
    assert.equal(s.left(), 0);
    assert.deepEqual(loadCustom(w.configDir).entries.map((e) => e.id), ['cool-addon']);

    assert.equal(await update({ yes: true, only: ['cool-addon'] }, w.deps), 0);
    // Add or remove > Remove > tick the first (CoolAddon) > confirm the list > yes > Enter > Quit
    const s2 = scripted(['3', '2', '1', '', '1', '', '6']);
    await runMenu({}, w.deps, s2.io);
    assert.equal(s2.left(), 0);
    assert.ok(!fs.existsSync(path.join(w.addons, 'CoolAddon')));
    assert.deepEqual(loadCustom(w.configDir).entries, []);
  } finally {
    await w.srv.close();
  }
});

test('inspect accepts a pin without a state record (first install of a pinned version)', () => {
  const dir = tmpDir();
  const item = /** @type {any} */ ({ id: 'n', owns: () => true, folders: ['N'], pin: '1.0.0' });
  const rel = /** @type {any} */ ({ version: '1.0.0', tag: 'v1.0.0', asset: { name: 'N-1.0.0.zip' } });
  assert.equal(inspect(item, rel, dir, undefined).status, 'not-installed');
});
