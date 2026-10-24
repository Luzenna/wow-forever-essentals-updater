// @ts-check
// End-to-end engine tests: fake release source + local HTTP server + fake AddOns tree.
// Upstream is modelled on Spoken 3.x: one "Spoken" zip holding the player, the
// modules and a placeholder for the retired SpokenPlayer folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeZip, serve, sha256, snapshot, tmpDir, toc, writeTree } from './helpers.js';
import { update, makePlan } from '../src/app.js';
import { saveConfig, loadConfig, DEFAULT_CONFIG, loadState, stateKey } from '../src/config.js';

/** A placeholder .toc the way upstream writes them. @param {string} title @param {string} v */
const placeholderToc = (title, v) => `## Interface: 100007, 16001\n## Title: |cff888888${title}|r\n## Version: ${v}\n## LoadOnDemand: 1\n`;

/** Fake upstream: one zip per tag prefix, built from a folder layout. */
function upstream(/** @type {Record<string, string>} */ versions) {
  const v = versions.spoken;
  /** @type {Record<string, Record<string, string>>} */
  const layouts = {
    spoken: {
      'Spoken/Spoken.toc': toc(v), 'Spoken/Core.lua': `core ${v}`,
      'Spoken_Quests/Spoken_Quests.toc': toc(v), 'Spoken_Quests/VoiceOver.lua': 'q',
      'Spoken_Zones/Spoken_Zones.toc': toc(v), 'Spoken_Zones/Core.lua': 'z',
      'Spoken_Books/Spoken_Books.toc': toc(v), 'Spoken_Books/Core.lua': 'b',
      'SpokenContributions/SpokenContributions.toc': toc(v, '16001', '## SavedVariables: SpokenContributionsDB\n'),
      'SpokenPlayer/SpokenPlayer.toc': placeholderToc('Spoken Player (now Spoken)', v),
    },
    'quests-audio': Object.fromEntries(['Alliance', 'Horde', 'Shared', 'Gossip'].flatMap((f) => [
      [`SpokenQuestsAudio${f}/SpokenQuestsAudio${f}.toc`, toc(versions['quests-audio'], '100000, 16001')],
      ...Array.from({ length: 20 }, (_, i) => [`SpokenQuestsAudio${f}/sounds/${i}.ogg`, `${f}-${i}`.repeat(50)]),
    ])),
  };
  const assetNames = { spoken: 'Spoken', 'quests-audio': 'SpokenQuestsAudioAll' };
  /** @type {Record<string, Buffer>} */
  const files = {};
  for (const [prefix, layout] of Object.entries(layouts)) files[`/${prefix}/${versions[prefix]}.zip`] = makeZip(layout);
  return { files, assetNames };
}

/**
 * @param {Record<string, string>} versions @param {string} baseUrl @param {ReturnType<typeof upstream>} up
 * @returns {import('../src/sources/source.js').Source & { calls: number }}
 */
function fakeSource(versions, baseUrl, up) {
  return {
    name: 'Fake',
    calls: 0,
    async latest(item) {
      this.calls++;
      const v = versions[item.tagPrefix];
      if (!v) return null;
      const body = up.files[`/${item.tagPrefix}/${v}.zip`];
      return {
        version: v, tag: `${item.tagPrefix}/v${v}`, source: 'Fake',
        asset: { name: `${/** @type {any} */ (up.assetNames)[item.tagPrefix]}-${v}.zip`, url: `${baseUrl}/${item.tagPrefix}/${v}.zip`, size: body.length, sha256: sha256(body) },
      };
    },
  };
}

/** Config with zones and books off (keeps fixtures small, exercises exclusion). @param {Record<string, string>} versions */
async function world(versions) {
  const home = tmpDir();
  const addons = path.join(home, 'wow', '_classic_beta_', 'Interface', 'AddOns');
  writeTree(addons, { 'Details/Details.toc': toc('1.0.0'), 'Details/Details.lua': 'keep me' });
  writeTree(path.join(home, 'wow', '_classic_beta_', 'WTF'), { 'Account/X/SavedVariables/Spoken.lua': 'settings' });
  const configDir = path.join(home, 'config');
  saveConfig(configDir, { ...DEFAULT_CONFIG, selected: ['spoken'], include_zones: false, include_books: false, addons_path: addons });
  const up = upstream(versions);
  const srv = await serve(up.files);
  const source = fakeSource(versions, srv.url, up);
  const deps = { source, configDir, cacheDir: path.join(home, 'cache'), runningWow: () => [], tty: false };
  return { home, addons, configDir, srv, deps, source, up };
}

const V1 = { spoken: '3.1.0', 'quests-audio': '2.2.0' };
const act = async (/** @type {any} */ deps) => (await makePlan({}, deps)).plans.filter((p) => p.act).map((p) => `${p.item.id}:${p.status}`);

test('fresh install, then a second run is a strict no-op', async () => {
  const w = await world(V1);
  try {
    assert.equal(await update({ yes: true }, w.deps), 0);
    assert.deepEqual(fs.readdirSync(w.addons).sort(), ['Details', 'Spoken', 'SpokenContributions', 'SpokenQuestsAudioAlliance',
      'SpokenQuestsAudioGossip', 'SpokenQuestsAudioHorde', 'SpokenQuestsAudioShared', 'Spoken_Quests'],
      'no SpokenPlayer placeholder, no switched-off Spoken_Zones/Spoken_Books');
    assert.equal(fs.readFileSync(path.join(w.addons, 'Details/Details.lua'), 'utf8'), 'keep me');
    assert.ok(!fs.existsSync(path.join(w.addons, '..', '.wow-forever-essentals-updater')), 'work dir cleaned up');
    assert.ok(!fs.existsSync(path.join(w.deps.cacheDir, 'downloads', 'spoken')), 'zips removed after success');

    const requestsBefore = w.srv.stats.requests;
    const before = snapshot(w.home);
    assert.equal(await update({ yes: true }, w.deps), 0);
    assert.equal(w.srv.stats.requests, requestsBefore, 'no downloads');
    assert.deepEqual(snapshot(w.home), before, 'no file changed anywhere: AddOns, WTF, config, state, cache');
  } finally {
    await w.srv.close();
  }
});

test('upgrading from the 2.x addons removes their folders in the same transaction', async () => {
  const w = await world(V1);
  try {
    // What an earlier version of this tool left behind: full 2.x copies, recorded in state,
    // plus an unrecorded SpokenBooks someone installed by hand, and a non-Spoken folder.
    writeTree(w.addons, {
      'SpokenPlayer/SpokenPlayer.toc': toc('2.3.2'), 'SpokenPlayer/Core.lua': 'old player',
      'SpokenContributions/SpokenContributions.toc': toc('2.3.2'),
      'SpokenQuests/SpokenQuests.toc': toc('2.2.1'), 'SpokenQuests/Core.lua': 'old quests',
      'SpokenZones/SpokenZones.toc': toc('2.2.1'), 'SpokenZones/Core.lua': 'old zones',
      'SpokenBooks/SpokenBooks.toc': toc('2.1.1'), 'SpokenBooks/Core.lua': 'old books',
      'VoiceOverRedux/VoiceOverRedux.toc': toc('2.0.0'),
    });
    const key = stateKey(w.addons);
    const rec = (/** @type {string[]} */ folders, /** @type {string} */ v) => ({
      tag: 'x', version: v, asset: 'x.zip', sha256: null, installedAt: '', folders: Object.fromEntries(folders.map((f) => [f, { files: 1, bytes: 1, tocVersion: v }])),
    });
    fs.writeFileSync(path.join(w.configDir, 'state.json'), JSON.stringify({ schema: 1, installs: { [key]: {
      player: rec(['SpokenPlayer', 'SpokenContributions'], '2.3.2'),
      quests: rec(['SpokenQuests', 'VoiceOverRedux'], '2.2.1'),
      zones: rec(['SpokenZones'], '2.2.1'),
    } } }));

    assert.deepEqual(await act(w.deps), ['spoken:not-installed', 'quests-audio:not-installed']);
    assert.equal(await update({ yes: true }, w.deps), 0);
    const names = fs.readdirSync(w.addons).sort();
    for (const gone of ['SpokenPlayer', 'SpokenQuests', 'SpokenZones', 'SpokenBooks']) assert.ok(!names.includes(gone), `${gone} removed`);
    for (const kept of ['Spoken', 'Spoken_Quests', 'SpokenContributions', 'Details', 'VoiceOverRedux']) assert.ok(names.includes(kept), `${kept} present`);
    assert.match(fs.readFileSync(path.join(w.addons, 'SpokenContributions/SpokenContributions.toc'), 'utf8'), /Version: 3\.1\.0/);

    const st = loadState(w.configDir).installs[key];
    assert.deepEqual(Object.keys(st).sort(), ['quests-audio', 'spoken'], 'retired items dropped from state');
    assert.deepEqual(await act(w.deps), [], 'settled');
  } finally {
    await w.srv.close();
  }
});

test('an old 2.x folder reappearing next to a current install gets removed', async () => {
  const w = await world(V1);
  try {
    await update({ yes: true }, w.deps);
    writeTree(w.addons, { 'SpokenQuests/SpokenQuests.toc': toc('2.2.1'), 'SpokenQuests/Core.lua': 'old' });
    assert.deepEqual(await act(w.deps), ['spoken:outdated']);
    await update({ yes: true }, w.deps);
    assert.ok(!fs.existsSync(path.join(w.addons, 'SpokenQuests')));
    assert.deepEqual(await act(w.deps), []);
  } finally {
    await w.srv.close();
  }
});

test('switching zones on and off adds and removes the module folder', async () => {
  const w = await world(V1);
  try {
    await update({ yes: true }, w.deps);
    saveConfig(w.configDir, { ...loadConfig(w.configDir), include_zones: true });
    // zones-audio has no fixture release, so it reports unavailable; the addon must still update.
    assert.deepEqual(await act(w.deps), ['spoken:outdated']);
    await update({ yes: true }, w.deps);
    assert.ok(fs.existsSync(path.join(w.addons, 'Spoken_Zones/Core.lua')));

    saveConfig(w.configDir, { ...loadConfig(w.configDir), include_zones: false });
    await update({ yes: true }, w.deps);
    assert.ok(!fs.existsSync(path.join(w.addons, 'Spoken_Zones')));
    assert.deepEqual(await act(w.deps), []);
  } finally {
    await w.srv.close();
  }
});

test('only the item with a newer release is updated', async () => {
  const w = await world(V1);
  try {
    await update({ yes: true }, w.deps);
    const audioBefore = snapshot(path.join(w.addons, 'SpokenQuestsAudioHorde'));
    const v2 = { ...V1, spoken: '3.2.0' };
    const up2 = upstream(v2);
    const srv2 = await serve(up2.files);
    try {
      const deps = { ...w.deps, source: fakeSource(v2, srv2.url, up2) };
      assert.deepEqual(await act(deps), ['spoken:outdated']);
      assert.equal(await update({ yes: true }, deps), 0);
      assert.equal(srv2.stats.requests, 1);
      assert.equal(fs.readFileSync(path.join(w.addons, 'Spoken/Core.lua'), 'utf8'), 'core 3.2.0');
      assert.deepEqual(snapshot(path.join(w.addons, 'SpokenQuestsAudioHorde')), audioBefore);
      assert.equal(Object.values(loadState(w.configDir).installs)[0].spoken.version, '3.2.0');
    } finally {
      await srv2.close();
    }
  } finally {
    await w.srv.close();
  }
});

test('missing folder, missing .toc and gutted folder each trigger a reinstall of just that item', async () => {
  const w = await world(V1);
  try {
    await update({ yes: true }, w.deps);
    fs.rmSync(path.join(w.addons, 'SpokenContributions'), { recursive: true });
    assert.deepEqual(await act(w.deps), ['spoken:missing']);
    await update({ yes: true }, w.deps);

    fs.rmSync(path.join(w.addons, 'Spoken_Quests/Spoken_Quests.toc'));
    assert.deepEqual(await act(w.deps), ['spoken:broken']);
    await update({ yes: true }, w.deps);

    for (const f of fs.readdirSync(path.join(w.addons, 'SpokenQuestsAudioShared/sounds')).slice(0, 10)) {
      fs.rmSync(path.join(w.addons, 'SpokenQuestsAudioShared/sounds', f));
    }
    assert.deepEqual(await act(w.deps), ['quests-audio:broken']);
    await update({ yes: true }, w.deps);
    assert.deepEqual(await act(w.deps), []);
  } finally {
    await w.srv.close();
  }
});

test('the .toc wins over the state file', async () => {
  const w = await world(V1);
  try {
    await update({ yes: true }, w.deps);
    fs.writeFileSync(path.join(w.addons, 'Spoken_Quests/Spoken_Quests.toc'), toc('3.0.0'));
    const sp = (await makePlan({}, w.deps)).plans.find((p) => p.item.id === 'spoken');
    assert.equal(sp?.installed, '3.0.0');
    assert.equal(sp?.status, 'outdated');
  } finally {
    await w.srv.close();
  }
});

test('folders installed by another manager are adopted when already current', async () => {
  const w = await world(V1);
  try {
    writeTree(w.addons, {
      'Spoken/Spoken.toc': toc(V1.spoken),
      ...Object.fromEntries(['Alliance', 'Horde', 'Shared', 'Gossip'].map((f) => [`SpokenQuestsAudio${f}/SpokenQuestsAudio${f}.toc`, toc(V1['quests-audio'])])),
    });
    const { plans } = await makePlan({}, w.deps);
    assert.deepEqual(plans.map((p) => `${p.item.id}:${p.status}`), ['spoken:current', 'quests-audio:current']);
  } finally {
    await w.srv.close();
  }
});

test('refuses to run while WoW is running unless --force', async () => {
  const w = await world(V1);
  try {
    const deps = { ...w.deps, runningWow: () => ['WowB.exe'] };
    await assert.rejects(update({ yes: true }, deps), /World of Warcraft is running/);
    assert.equal(w.srv.stats.requests, 0);
    assert.equal(await update({ yes: true, force: true }, deps), 0);
  } finally {
    await w.srv.close();
  }
});

test('dry run downloads and changes nothing', async () => {
  const w = await world(V1);
  try {
    const before = snapshot(w.home);
    assert.equal(await update({ yes: true, dryRun: true }, w.deps), 0);
    assert.equal(w.srv.stats.requests, 0);
    assert.deepEqual(snapshot(w.home), before);
  } finally {
    await w.srv.close();
  }
});

test('install --only reinstalls a current item and nothing else', async () => {
  const w = await world(V1);
  try {
    await update({ yes: true }, w.deps);
    const n = w.srv.stats.requests;
    assert.equal(await update({ yes: true, only: ['spoken'] }, w.deps), 0);
    assert.equal(w.srv.stats.requests, n + 1);
    await assert.rejects(update({ yes: true, only: ['quests'] }, w.deps), /unknown item/, 'retired ids are gone');
  } finally {
    await w.srv.close();
  }
});

test('a broken release for one item does not stop the others', async () => {
  const w = await world(V1);
  try {
    const orig = w.source.latest.bind(w.source);
    w.source.latest = async (item) => {
      if (item.id === 'quests-audio') throw new Error('no Forever-compatible zip among assets: (none)');
      return orig(item);
    };
    assert.equal(await update({ yes: true }, w.deps), 1, 'exit 1 because one item failed');
    assert.ok(fs.existsSync(path.join(w.addons, 'Spoken')));
    assert.ok(!fs.existsSync(path.join(w.addons, 'SpokenQuestsAudioHorde')));
  } finally {
    await w.srv.close();
  }
});

test('a newer installed version is never downgraded', async () => {
  const w = await world(V1);
  try {
    await update({ yes: true }, w.deps);
    // Same-length edit, so the size health check stays quiet: only the version differs.
    for (const f of ['Spoken', 'Spoken_Quests', 'SpokenContributions']) {
      const p = path.join(w.addons, f, `${f}.toc`);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('Version: 3.1.0', 'Version: 9.0.0'));
    }
    const sp = (await makePlan({}, w.deps)).plans.find((p) => p.item.id === 'spoken');
    assert.equal(sp?.status, 'current');
    assert.equal(sp?.act, false);
    assert.match(sp?.reason ?? '', /newer/);
  } finally {
    await w.srv.close();
  }
});

test('a second instance is refused while the first holds the lock', async () => {
  const w = await world(V1);
  try {
    // Another live process (this one's parent stands in for it) holds the lock.
    fs.writeFileSync(path.join(w.configDir, 'wow-forever-essentals-updater.lock'), String(process.ppid));
    await assert.rejects(update({ yes: true }, w.deps), /already running/);
    assert.equal(w.srv.stats.requests, 0);
    // A lock from a dead process is taken over.
    fs.writeFileSync(path.join(w.configDir, 'wow-forever-essentals-updater.lock'), '999999');
    assert.equal(await update({ yes: true }, w.deps), 0);
    assert.ok(!fs.existsSync(path.join(w.configDir, 'wow-forever-essentals-updater.lock')), 'lock released');
  } finally {
    await w.srv.close();
  }
});

test('dry run with an interrupted install pending changes nothing; a real run recovers it', async () => {
  const w = await world(V1);
  try {
    await update({ yes: true }, w.deps);
    // Simulate a crash mid-swap of Spoken: original moved to backup, journal left behind.
    const work = path.join(w.addons, '..', '.wow-forever-essentals-updater');
    const bak = path.join(work, 'bak-1');
    fs.mkdirSync(bak, { recursive: true });
    fs.renameSync(path.join(w.addons, 'Spoken'), path.join(bak, 'Spoken'));
    fs.writeFileSync(path.join(work, 'journal.json'), JSON.stringify({
      bakDir: bak, committed: false,
      moves: [{ kind: 'backup', from: path.join(w.addons, 'Spoken'), to: path.join(bak, 'Spoken') }],
    }));
    const before = snapshot(w.home);
    assert.equal(await update({ yes: true, dryRun: true }, w.deps), 0);
    assert.deepEqual(snapshot(w.home), before);

    const n = w.srv.stats.requests;
    assert.equal(await update({ yes: true }, w.deps), 0);
    assert.ok(fs.existsSync(path.join(w.addons, 'Spoken/Spoken.toc')), 'original restored');
    assert.equal(w.srv.stats.requests, n, 'restored folder was current, nothing downloaded');
    assert.ok(!fs.existsSync(work));
  } finally {
    await w.srv.close();
  }
});
