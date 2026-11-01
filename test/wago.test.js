// @ts-check
// Addons released only on Wago Addons: the page parser, the source against a fake Wago
// (page, redirecting download link, CDN file), and a whole install and update through it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { makeZip, tmpDir, toc } from './helpers.js';
import { update, makePlan } from '../src/app.js';
import { saveConfig, loadConfig, loadState, stateKey, DEFAULT_CONFIG } from '../src/config.js';
import { MultiSource } from '../src/sources/multi.js';
import { WagoSource, parseAddonPage } from '../src/sources/wago.js';
import { buildCatalog, withRequired } from '../src/catalog.js';
import { BUILTIN, DEFAULT_SELECTED } from '../src/addons.js';
import { validate } from '../src/custom.js';
import * as semver from '../src/semver.js';

/** Escape a string the way a server puts JSON into an HTML attribute. @param {string} s */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#039;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** An addon page as Wago sends it. @param {unknown} releases */
const pageHtml = (releases) =>
  `<!doctype html><html><head><title>x</title></head><body><div id="app" data-page="${esc(JSON.stringify({ props: { metadata: { recent_releases: releases } } }))}"></div></body></html>`;

/**
 * A fake Wago: /addons/<slug> pages, /download/<slug> redirecting to a CDN file under /cdn/.
 * `addons` maps a slug to its folder names and current label; change `label` to publish an update.
 * @param {Record<string, { folders: string[], label: string, changelog?: string, noForever?: boolean }>} addons
 */
async function fakeWago(addons) {
  const stats = { pages: 0, heads: 0, zipGets: 0 };
  const zipFor = (/** @type {string} */ slug) => {
    const a = addons[slug];
    return makeZip(Object.fromEntries(a.folders.flatMap((f) => [[`${f}/${f}.toc`, toc(a.label, '16001, 120100')], [`${f}/main.lua`, `-- ${slug} ${a.label}`]])));
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const base = `http://${req.headers.host}`;
    const page = /^\/addons\/([^/]+)$/.exec(url.pathname);
    const dl = /^\/download\/([^/]+)$/.exec(url.pathname);
    const cdn = /^\/cdn\/([^/]+)\.zip$/.exec(url.pathname);
    if (page && addons[page[1]]) {
      stats.pages++;
      const a = addons[page[1]];
      const forever = a.noForever ? undefined : { label: a.label, changelog: a.changelog ?? `# ${page[1]}\r\n\r\n- fixed a thing\r\n[Full Changelog](https://example.invalid/compare)\r\n`, download_link: `${base}/download/${page[1]}?expires=9999999999&link=abc` };
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(pageHtml(forever ? { retail: forever, forever } : {}));
    } else if (dl && addons[dl[1]]) {
      if (req.method === 'HEAD') stats.heads++;
      res.writeHead(302, { Location: `/cdn/${dl[1]}-${addons[dl[1]].label}.zip` }).end();
    } else if (cdn) {
      // File names are "<slug>-<label>.zip", and a label can itself contain dashes ("13.16.2-forever").
      const slug = Object.keys(addons).find((s) => cdn[1].startsWith(`${s}-`));
      if (!slug) {
        res.writeHead(404).end();
        return;
      }
      const body = zipFor(slug);
      if (req.method !== 'HEAD') stats.zipGets++;
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': body.length }).end(req.method === 'HEAD' ? undefined : body);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  return { url, stats, addons, close: () => new Promise((r) => server.close(() => r(undefined))) };
}

/** @param {string} id @param {string} wago */
const wagoItem = (id, wago) => /** @type {any} */ ({ id, wago, loose: true, tagMode: 'plain', folders: [id] });

test('the page parser reads the forever release, and says what changed when the page is not what it knows', () => {
  const html = pageHtml({ forever: { label: '839', download_link: 'https://addons.wago.io/download/x', changelog: 'it\'s "new" & <good>' }, retail: { label: '1' } });
  const r = parseAddonPage(html);
  assert.equal(r?.label, '839');
  assert.equal(r?.changelog, 'it\'s "new" & <good>', 'entities are undone, & last');
  assert.equal(parseAddonPage(html, 'retail')?.label, '1');
  assert.equal(parseAddonPage(pageHtml({ retail: { label: '1' } })), null, 'no forever build');
  assert.equal(parseAddonPage(pageHtml([])), null, 'PHP sends "no releases" as []');
  assert.throws(() => parseAddonPage('<html>nothing here</html>'), /no data-page block/);
  assert.throws(() => parseAddonPage('<div data-page="{oops"></div>'), /not valid JSON/);
  assert.throws(() => parseAddonPage(`<div data-page="${esc(JSON.stringify({ props: {} }))}"></div>`), /no release list/);
});

test('bare build numbers compare as numbers, only when asked to', () => {
  assert.equal(semver.compare('840', '839', { loose: true }), 1);
  assert.equal(semver.compare('9', '10', { loose: true }), -1, 'numeric, not alphabetical');
  assert.equal(semver.compare('839', '839', { loose: true }), 0);
  assert.equal(semver.compare('1.2.62', 'v1.2.61', { loose: true }), 1);
  assert.equal(semver.valid('839'), false, 'strict mode is unchanged');
  assert.equal(semver.valid('839', { loose: true }), true);
  assert.equal(semver.valid('abc', { loose: true }), false);
});

test('WagoSource finds the zip, its size and its notes with one page request and one HEAD', async () => {
  const w = await fakeWago({ baganator: { folders: ['Baganator'], label: 'v839' } });
  try {
    const src = new WagoSource({ base: w.url, retry: { retries: 0 } });
    const rel = await src.latest(wagoItem('baganator', 'baganator'));
    assert.ok(rel);
    assert.equal(rel.version, '839', 'a leading v is dropped like for GitHub tags');
    assert.equal(rel.tag, 'v839');
    assert.equal(rel.source, 'Wago');
    assert.equal(rel.asset.name, 'baganator-v839.zip');
    assert.equal(rel.asset.url, `${w.url}/cdn/baganator-v839.zip`, 'the redirect target, not the signed link');
    assert.ok(rel.asset.size > 100, 'the size comes from the HEAD response');
    assert.equal(rel.asset.sha256, null);
    assert.match(rel.notes ?? '', /fixed a thing/);
    assert.doesNotMatch(rel.notes ?? '', /Full Changelog/);
    await src.latest(wagoItem('baganator', 'baganator'));
    assert.equal(w.stats.pages, 1, 'the page is fetched once per run');
    assert.equal(w.stats.zipGets, 0, 'checking never downloads the zip');
  } finally {
    await w.close();
  }
});

test('a "-forever" label suffix is the flavor, not part of the version', async () => {
  const w = await fakeWago({ eqol: { folders: ['EnhanceQoL'], label: '13.16.2-forever' } });
  try {
    const src = new WagoSource({ base: w.url, retry: { retries: 0 } });
    const rel = await src.latest(wagoItem('enhanceqol', 'eqol'));
    assert.equal(rel?.version, '13.16.2', 'matches the .toc Version');
    assert.equal(rel?.tag, '13.16.2-forever', 'the tag keeps what Wago called it');
    assert.equal((await src.latest({ ...wagoItem('enhanceqol', 'eqol'), pin: '13.16.2-forever' }))?.version, '13.16.2');
  } finally {
    await w.close();
  }
});

test('WagoSource: no forever build is "no release", an unknown addon and a pin are plain errors', async () => {
  const w = await fakeWago({ old: { folders: ['Old'], label: '3', noForever: true }, baganator: { folders: ['Baganator'], label: '839' } });
  try {
    const src = new WagoSource({ base: w.url, retry: { retries: 0 } });
    assert.equal(await src.latest(wagoItem('old', 'old')), null);
    await assert.rejects(src.latest(wagoItem('nope', 'nope')), /"nope" was not found on Wago Addons/);
    await assert.rejects(src.latest({ ...wagoItem('baganator', 'baganator'), pin: '838' }), /only offers the newest baganator \(839\)/);
    assert.equal((await src.latest({ ...wagoItem('baganator', 'baganator'), pin: '839' }))?.version, '839');
    await assert.rejects(src.latest(/** @type {any} */ ({ id: 'x', tagMode: 'plain' })), /no Wago slug/);
  } finally {
    await w.close();
  }
});

test('WagoSource never follows a download link that leaves Wago, or accepts a version it cannot read', async () => {
  const bad = http.createServer((req, res) => {
    const forever = req.url?.includes('badver')
      ? { label: 'banana', download_link: 'http://127.0.0.1/x' }
      : { label: '1', download_link: 'https://evil.example/download/x' };
    res.writeHead(200).end(pageHtml({ forever }));
  });
  await new Promise((r) => bad.listen(0, '127.0.0.1', () => r(undefined)));
  const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (bad.address()).port}`;
  try {
    const src = new WagoSource({ base, retry: { retries: 0 } });
    await assert.rejects(src.latest(wagoItem('a', 'offsite')), /download link points to https:\/\/evil\.example/);
    await assert.rejects(src.latest(wagoItem('b', 'badver')), /"banana" is not a version number/);
  } finally {
    await new Promise((r) => bad.close(() => r(undefined)));
  }
});

test('an addon that needs another brings it, and nothing else', () => {
  assert.deepEqual(withRequired(['baganator'], BUILTIN).sort(), ['baganator', 'syndicator']);
  assert.deepEqual(withRequired(['syndicator'], BUILTIN), ['syndicator']);
  assert.deepEqual(withRequired(['chattynator'], BUILTIN), ['chattynator']);
  const ids = buildCatalog({ language: 'enUS', includeZones: false, includeBooks: false, selected: ['baganator'] }).map((i) => i.id);
  assert.deepEqual(ids.sort(), ['baganator', 'syndicator']);
  const item = buildCatalog({ language: 'enUS', includeZones: false, includeBooks: false, selected: ['journalator'] })[0];
  assert.equal(item.wago, 'journalator');
  assert.equal(item.loose, true);
  assert.deepEqual(item.folders, ['Journalator', 'Journalator_Display', 'Journalator_OptionsUI', 'Journalator_Statistics']);
  assert.ok(item.owns('journalator_display') && !item.owns('Auctionator'));
});

test('a fresh config leaves the opt-in extras off, and the extras are all there', () => {
  assert.deepEqual(DEFAULT_CONFIG.selected, DEFAULT_SELECTED);
  for (const id of ['dialogkey', 'syndicator', 'baganator', 'auctionator', 'journalator', 'chattynator', 'platynator', 'enhanceqol']) {
    assert.ok(BUILTIN.some((a) => a.id === id), id);
    assert.ok(!DEFAULT_SELECTED.includes(id), `${id} is opt-in`);
  }
  assert.ok(DEFAULT_SELECTED.includes('nodesight') && DEFAULT_SELECTED.includes('spoken'), 'the original addons stay on');
});

test('addons.json accepts a Wago addon by slug, and refuses a muddle', () => {
  const { entries, problems } = validate([
    { wago: 'Some-Addon', folders: ['SomeAddon'] },
    { wago: 'both', repo: 'a/b', folders: ['Both'] },
    { wago: 'bad slug!', folders: ['Bad'] },
    { folders: ['Nothing'] },
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'some-addon');
  assert.equal(entries[0].wago, 'some-addon');
  assert.equal(entries[0].repo, undefined);
  assert.equal(entries[0].title, 'some-addon');
  assert.match(problems[0], /either "repo" or "wago"/);
  assert.match(problems[1], /addons\.wago\.io address/);
  assert.match(problems[2], /"repo" must look like owner\/name/);
});

test('install, settle and update through Wago, with Syndicator pulled in for Baganator', async () => {
  const w = await fakeWago({
    baganator: { folders: ['Baganator'], label: '839' },
    syndicator: { folders: ['Syndicator'], label: '288' },
  });
  const home = tmpDir();
  const addons = path.join(home, 'wow', '_classic_beta_', 'Interface', 'AddOns');
  fs.mkdirSync(addons, { recursive: true });
  const configDir = path.join(home, 'config');
  saveConfig(configDir, { ...DEFAULT_CONFIG, addons_path: addons, selected: ['baganator'] });
  // A new source is a new run: the page of each addon is read once per source, like GitHub's release list.
  const run = () => ({ source: new MultiSource({ wagoBase: w.url, retry: { retries: 0 } }), configDir, cacheDir: path.join(home, 'cache'), runningWow: () => [], tty: false });
  try {
    assert.equal(await update({ yes: true }, run()), 0);
    assert.deepEqual(fs.readdirSync(addons).sort(), ['Baganator', 'Syndicator']);
    const st = loadState(configDir).installs[stateKey(addons)];
    assert.equal(st.baganator.version, '839');
    assert.equal(st.syndicator.version, '288');
    assert.equal(st.baganator.sha256, null);
    assert.equal(w.stats.zipGets, 2);

    // Nothing new upstream: no download, and 839 vs 839 reads as current.
    assert.deepEqual((await makePlan({}, run())).plans.map((p) => p.status), ['current', 'current']);
    assert.equal(await update({ yes: true }, run()), 0);
    assert.equal(w.stats.zipGets, 2, 'no second download');

    // 840 is newer than 839 even though neither is a dotted version.
    w.addons.baganator.label = '840';
    const plans = (await makePlan({}, run())).plans;
    assert.deepEqual(plans.map((p) => [p.item.id, p.status]), [['syndicator', 'current'], ['baganator', 'outdated']]);
    assert.equal(await update({ yes: true }, run()), 0);
    assert.match(fs.readFileSync(path.join(addons, 'Baganator', 'Baganator.toc'), 'utf8'), /Version: 840/);
    assert.equal(w.stats.zipGets, 3, 'only the one that changed');

    // An installed build that is newer than Wago's is never downgraded.
    w.addons.baganator.label = '839';
    assert.equal((await makePlan({}, run())).plans.find((p) => p.item.id === 'baganator')?.status, 'current');
    assert.equal(loadConfig(configDir).selected.includes('syndicator'), false, 'the stored selection is not rewritten by an update');
  } finally {
    await w.close();
  }
});
