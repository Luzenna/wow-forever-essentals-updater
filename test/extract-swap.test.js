// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeZip, tmpDir, toc, writeTree, snapshot } from './helpers.js';
import { extractZip, findAddonRoots, isSpokenFolder, isPlaceholder, normaliseEntryName } from '../src/extract.js';
import { swapIn, recover } from '../src/swap.js';

/** Extract a zip built from `files` and return the addon roots found. @param {Record<string, string>} files */
async function rootsOf(files) {
  const dir = tmpDir();
  const zip = path.join(dir, 'a.zip');
  fs.writeFileSync(zip, makeZip(files));
  const staging = path.join(dir, 'staging');
  await extractZip(zip, staging);
  return { staging, roots: findAddonRoots(staging) };
}

/** @param {{ name: string, dir: string }[]} roots */
const names = (roots) => roots.map((r) => r.name).sort();

test('plain multi-folder zip', async () => {
  const { roots } = await rootsOf({
    'SpokenPlayer/SpokenPlayer.toc': toc('2.3.2'),
    'SpokenPlayer/Core.lua': 'x',
    'SpokenContributions/SpokenContributions.toc': toc('2.3.2'),
  });
  assert.deepEqual(names(roots), ['SpokenContributions', 'SpokenPlayer']);
});

test('backslash paths are normalised', async () => {
  const { roots } = await rootsOf({
    'SpokenBooks\\SpokenBooks.toc': toc('2.1.1'),
    'SpokenBooks\\Data\\books.lua': 'x',
  });
  assert.deepEqual(names(roots), ['SpokenBooks']);
  assert.ok(fs.existsSync(path.join(roots[0].dir, 'Data', 'books.lua')));
});

test('wrapper folder and double nesting collapse to the real addon folder', async () => {
  const { roots } = await rootsOf({
    'SpokenZones-2.2.1/SpokenZones/SpokenZones/SpokenZones.toc': toc('2.2.1'),
    'SpokenZones-2.2.1/SpokenZones/SpokenZones/Core.lua': 'x',
    'SpokenZones-2.2.1/SpokenZones/SpokenZones.toc': toc('2.2.1'),
  });
  assert.equal(roots.length, 1);
  assert.equal(roots[0].name, 'SpokenZones');
  assert.ok(fs.existsSync(path.join(roots[0].dir, 'Core.lua')));
});

test('flat zip (toc at the root) gets wrapped into a folder named after the toc', async () => {
  const { roots } = await rootsOf({ 'SpokenBooks.toc': toc('2.1.1'), 'Core.lua': 'x' });
  assert.deepEqual(names(roots), ['SpokenBooks']);
  assert.ok(fs.existsSync(path.join(roots[0].dir, 'Core.lua')));
});

test('macOS junk is ignored and zip-slip is refused', async () => {
  const { roots } = await rootsOf({ '__MACOSX/SpokenBooks/._x': 'x', 'SpokenBooks/SpokenBooks.toc': toc('1.0.0'), 'SpokenBooks/.DS_Store': 'x' });
  assert.deepEqual(names(roots), ['SpokenBooks']);
  await assert.rejects(rootsOf({ '../evil.txt': 'x' }), /unsafe path/);
  await assert.rejects(rootsOf({ 'a\\..\\..\\evil.txt': 'x' }), /unsafe path/);
  assert.throws(() => normaliseEntryName('C:/Windows/x'), /unsafe/);
  assert.throws(() => normaliseEntryName('/etc/passwd'), /unsafe/);
});

test('only Spoken* folders qualify; the VoiceOverRedux/ZoneLore placeholders never do', async () => {
  const { roots } = await rootsOf({
    'SpokenQuests/SpokenQuests.toc': toc('2.2.1'),
    'VoiceOverRedux/VoiceOverRedux.toc': toc('2.0.0', '11509', '## X-Part-Of: Spoken\n'),
    'SomeLib/SomeLib.toc': toc('1.0.0'),
  });
  const keep = roots.filter((r) => isSpokenFolder(r.name)).map((r) => r.name).sort();
  assert.deepEqual(keep, ['SpokenQuests']);
});

/** An AddOns folder with an old Spoken install and an unrelated addon. */
function addonsFixture() {
  const root = tmpDir();
  const addons = path.join(root, 'Interface', 'AddOns');
  writeTree(addons, {
    'SpokenPlayer/SpokenPlayer.toc': toc('2.3.1'),
    'SpokenPlayer/old.lua': 'old',
    'Details/Details.toc': toc('9.9.9'),
  });
  const staging = path.join(root, 'staging');
  writeTree(staging, {
    'SpokenPlayer/SpokenPlayer.toc': toc('2.3.2'),
    'SpokenPlayer/new.lua': 'new',
    'SpokenContributions/SpokenContributions.toc': toc('2.3.2'),
  });
  const roots = ['SpokenPlayer', 'SpokenContributions'].map((name) => ({ name, dir: path.join(staging, name) }));
  return { root, addons, roots, work: path.join(root, 'Interface', '.wow-forever-essentals-updater') };
}

test('swap replaces Spoken folders and leaves everything else alone', () => {
  const f = addonsFixture();
  const details = snapshot(path.join(f.addons, 'Details'));
  swapIn({ addons: f.addons, roots: f.roots, workDir: f.work });
  assert.ok(fs.existsSync(path.join(f.addons, 'SpokenPlayer', 'new.lua')));
  assert.ok(!fs.existsSync(path.join(f.addons, 'SpokenPlayer', 'old.lua')));
  assert.ok(fs.existsSync(path.join(f.addons, 'SpokenContributions')));
  assert.deepEqual(snapshot(path.join(f.addons, 'Details')), details);
  assert.deepEqual(fs.readdirSync(f.work), [], 'backup and journal removed');
});

test('swap rolls back when a rename fails midway', () => {
  const f = addonsFixture();
  const before = snapshot(f.addons);
  let n = 0;
  const rename = (/** @type {string} */ a, /** @type {string} */ b) => {
    if (++n === 3) throw new Error('disk on fire'); // after backup + first install
    fs.renameSync(a, b);
  };
  assert.throws(() => swapIn({ addons: f.addons, roots: f.roots, workDir: f.work, rename }), /disk on fire/);
  assert.deepEqual(snapshot(f.addons), before);
  assert.ok(!fs.existsSync(path.join(f.work, 'journal.json')));
});

/** Leave AddOns the way a process killed mid-swap would: old folder in backup, new one moved in. @param {ReturnType<typeof addonsFixture>} f @param {boolean} committed */
function halfSwap(f, committed) {
  const bakDir = path.join(f.work, 'bak-1');
  fs.mkdirSync(bakDir, { recursive: true });
  const moves = [
    { kind: 'backup', from: path.join(f.addons, 'SpokenPlayer'), to: path.join(bakDir, 'SpokenPlayer') },
    { kind: 'install', from: f.roots[0].dir, to: path.join(f.addons, 'SpokenPlayer') },
  ];
  for (const m of moves) fs.renameSync(m.from, m.to);
  fs.writeFileSync(path.join(f.work, 'journal.json'), JSON.stringify({ bakDir, moves, committed }));
}

test('a crash mid-swap is rolled back on the next run', () => {
  const f = addonsFixture();
  const before = snapshot(f.addons);
  halfSwap(f, false);
  assert.match(String(recover(f.work)), /rolled back/);
  assert.deepEqual(snapshot(f.addons), before);
  assert.ok(!fs.existsSync(f.work), 'work dir removed');
});

test('a crash after commit keeps the new files and only cleans up', () => {
  const f = addonsFixture();
  halfSwap(f, true);
  assert.match(String(recover(f.work)), /finished/);
  assert.ok(fs.existsSync(path.join(f.addons, 'SpokenPlayer', 'new.lua')));
  assert.ok(!fs.existsSync(f.work), 'work dir removed');
  assert.equal(recover(f.work), null, 'nothing to do the second time');
});

test('lowercase existing folder is replaced, not duplicated', () => {
  const f = addonsFixture();
  fs.renameSync(path.join(f.addons, 'SpokenPlayer'), path.join(f.addons, 'spokenplayer_tmp'));
  fs.renameSync(path.join(f.addons, 'spokenplayer_tmp'), path.join(f.addons, 'spokenplayer'));
  swapIn({ addons: f.addons, roots: f.roots, workDir: f.work });
  const entries = fs.readdirSync(f.addons).filter((n) => n.toLowerCase() === 'spokenplayer');
  assert.equal(entries.length, 1);
  assert.ok(fs.existsSync(path.join(f.addons, entries[0], 'new.lua')));
});

test('rollback never deletes an install target the swap did not create', () => {
  const f = addonsFixture();
  // A *file* named like a Spoken folder: no backup is made for it, and renaming
  // the staged folder onto it fails. The file must survive the rollback.
  fs.writeFileSync(path.join(f.addons, 'SpokenContributions'), 'not a folder');
  let n = 0;
  const rename = (/** @type {string} */ a, /** @type {string} */ b) => {
    if (++n === 3) throw new Error('target exists');
    fs.renameSync(a, b);
  };
  assert.throws(() => swapIn({ addons: f.addons, roots: f.roots, workDir: f.work, rename }), /target exists/);
  assert.equal(fs.readFileSync(path.join(f.addons, 'SpokenContributions'), 'utf8'), 'not a folder');
  assert.ok(fs.existsSync(path.join(f.addons, 'SpokenPlayer', 'old.lua')), 'original restored');
});

test('placeholders are recognised; SpokenContributions (toc-only data holder) is not one', async () => {
  const { roots } = await rootsOf({
    'SpokenPlayer/SpokenPlayer.toc': '## Interface: 100007, 16001\n## Title: |cff888888Spoken Player (now Spoken)|r\n## LoadOnDemand: 1\n',
    'ZoneLore/ZoneLore.toc': '## Title: ZoneLore\n## X-Spoken-Tombstone: 1\n',
    'SpokenContributions/SpokenContributions.toc': '## Title: |cff888888Spoken Contributions|r\n## SavedVariables: SpokenContributionsDB\n',
    // Has code, so never a placeholder whatever its title says.
    'Spoken/Spoken.toc': '## Title: Spoken (now with more lore)\n', 'Spoken/Core.lua': 'code',
  });
  const by = Object.fromEntries(roots.map((r) => [r.name, isPlaceholder(r.dir)]));
  assert.deepEqual(by, { SpokenPlayer: true, ZoneLore: true, SpokenContributions: false, Spoken: false });
});

test('swap can remove retired folders in the same transaction, and restores them on failure', () => {
  const f = addonsFixture();
  writeTree(f.addons, { 'SpokenQuests/SpokenQuests.toc': toc('2.2.1'), 'SpokenQuests/Core.lua': 'old' });
  const before = snapshot(f.addons);
  let n = 0;
  const failing = (/** @type {string} */ a, /** @type {string} */ b) => {
    if (++n === 4) throw new Error('boom');
    fs.renameSync(a, b);
  };
  assert.throws(() => swapIn({ addons: f.addons, roots: f.roots, remove: ['SpokenQuests'], workDir: f.work, rename: failing }), /boom/);
  assert.deepEqual(snapshot(f.addons), before, 'removed folder restored too');

  // A failed swap consumes its staging copy, so start over for the success case.
  const g = addonsFixture();
  writeTree(g.addons, { 'SpokenQuests/SpokenQuests.toc': toc('2.2.1') });
  swapIn({ addons: g.addons, roots: g.roots, remove: ['SpokenQuests', 'SpokenPlayer'], workDir: g.work });
  assert.ok(!fs.existsSync(path.join(g.addons, 'SpokenQuests')));
  assert.ok(fs.existsSync(path.join(g.addons, 'SpokenPlayer', 'new.lua')), 'a folder being installed is never removed');
  assert.ok(fs.existsSync(path.join(g.addons, 'Details')));
});

/** A rename that refuses to move one folder, the way Windows does when a program's current directory is inside it. @param {string} busyDir */
const renameWithBusyDir = (busyDir) => (/** @type {string} */ a, /** @type {string} */ b) => {
  if (path.resolve(a) === path.resolve(busyDir)) throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${a}'`), { code: 'EBUSY', path: a });
  fs.renameSync(a, b);
};

test('a folder that cannot be renamed is replaced in place', () => {
  const f = addonsFixture();
  const details = snapshot(path.join(f.addons, 'Details'));
  const folder = path.join(f.addons, 'SpokenPlayer');
  swapIn({ addons: f.addons, roots: f.roots, workDir: f.work, rename: renameWithBusyDir(folder) });
  assert.deepEqual(fs.readdirSync(folder).sort(), ['SpokenPlayer.toc', 'new.lua'], 'old files out, new files in, same folder');
  assert.match(fs.readFileSync(path.join(folder, 'SpokenPlayer.toc'), 'utf8'), /2\.3\.2/);
  assert.ok(fs.existsSync(path.join(f.addons, 'SpokenContributions')), 'the other root still installs normally');
  assert.deepEqual(snapshot(path.join(f.addons, 'Details')), details);
  assert.deepEqual(fs.readdirSync(f.work), [], 'backup and journal removed');
});

test('an in-place replacement that fails midway restores the old folder and explains why', () => {
  const f = addonsFixture();
  const before = snapshot(f.addons);
  const folder = path.join(f.addons, 'SpokenPlayer');
  const busy = renameWithBusyDir(folder);
  const rename = (/** @type {string} */ a, /** @type {string} */ b) => {
    if (a.endsWith('new.lua')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY', path: a });
    busy(a, b);
  };
  assert.throws(() => swapIn({ addons: f.addons, roots: f.roots, workDir: f.work, rename }), /in use by another program.*Nothing was changed/s);
  // Every file is back; only the folder's own modified time moved, because it was emptied and refilled.
  const files = (/** @type {Record<string, string>} */ snap) => Object.fromEntries(Object.entries(snap).filter(([k]) => !k.endsWith('/')));
  assert.deepEqual(files(snapshot(f.addons)), files(before));
  assert.ok(!fs.existsSync(path.join(f.work, 'journal.json')));
});

test('a program sitting in the folder does not stop the swap (real Windows lock)', { skip: process.platform !== 'win32' }, async () => {
  const f = addonsFixture();
  const folder = path.join(f.addons, 'SpokenPlayer');
  const { spawn } = await import('node:child_process');
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: folder, stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 500));
    // The plain rename must fail here, or this test proves nothing.
    assert.throws(() => fs.renameSync(folder, folder + '.x'), /EBUSY|EPERM|EACCES/);
    swapIn({ addons: f.addons, roots: f.roots, workDir: f.work, rename: (a, b) => fs.renameSync(a, b) });
    assert.deepEqual(fs.readdirSync(folder).sort(), ['SpokenPlayer.toc', 'new.lua']);
  } finally {
    holder.kill();
  }
});
