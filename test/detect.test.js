// @ts-check
// AddOns detection against fake directory trees laid out like a Windows PC and a Steam Deck.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, writeTree } from './helpers.js';
import { detect, winePath } from '../src/detect/detect.js';
import { encodeProductDb, parseProductDb } from '../src/detect/productdb.js';
import { parseBuildInfo } from '../src/detect/buildinfo.js';
import { resolveFold } from '../src/detect/fold.js';

const BUILD_INFO =
  'Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Key!HEX:16|Version!STRING:0|Product!STRING:0\n' +
  'us|1|aa|bb|1.15.9.70003|wow_classic_era\n' +
  'us|1|cc|dd|1.60.1.70205|wow_classic_beta\n';

/** @param {Partial<import('../src/detect/detect.js').Env>} over @returns {import('../src/detect/detect.js').Env} */
const env = (over) => ({ platform: 'linux', home: '/nonexistent', drives: [], appData: null, runMedia: '/nonexistent', registryInstallDirs: () => [], ...over });

/** Create a WoW root with the given client folders. @param {string} root @param {string[]} clients */
function wowRoot(root, clients, { buildInfo = true, interfaceName = 'Interface', addonsName = 'AddOns' } = {}) {
  for (const c of clients) fs.mkdirSync(path.join(root, c, interfaceName, addonsName), { recursive: true });
  if (buildInfo) fs.writeFileSync(path.join(root, '.build.info'), BUILD_INFO);
}

test('product.db round-trips through the encoder used to document its layout', () => {
  const products = [{ code: 'wow_classic_beta', location: 'C:/Games/World of Warcraft', folder: '_classic_beta_', version: '1.60.1.70205' }];
  assert.deepEqual(parseProductDb(encodeProductDb(products)), products);
  assert.deepEqual(parseProductDb(Buffer.from([0xff, 0xff])), []);
});

test('.build.info columns are found by name', () => {
  const rows = parseBuildInfo(BUILD_INFO);
  assert.deepEqual(rows[1], { product: 'wow_classic_beta', version: '1.60.1.70205', active: true });
});

test('Windows: Battle.net product.db on a custom drive path', () => {
  const t = tmpDir();
  const drive = path.join(t, 'D');
  const wow = path.join(drive, 'Games', 'World of Warcraft');
  wowRoot(wow, ['_classic_era_', '_classic_beta_']);
  writeTree(drive, {});
  fs.mkdirSync(path.join(drive, 'ProgramData/Battle.net/Agent'), { recursive: true });
  fs.writeFileSync(path.join(drive, 'ProgramData/Battle.net/Agent/product.db'), encodeProductDb([
    { code: 'wow_classic_era', location: wow.replace(/\\/g, '/'), folder: '_classic_era_', version: '1.15.9.70003' },
    { code: 'wow_classic_beta', location: wow.replace(/\\/g, '/'), folder: '_classic_beta_', version: '1.60.1.70205' },
    { code: 'agent', location: 'C:/ProgramData/Battle.net/Agent', folder: '', version: '2.41' },
  ]));
  const found = detect({ clientFolder: '_classic_beta_' }, env({ platform: 'win32', drives: [drive] }));
  assert.equal(found.length, 1);
  assert.equal(found[0].addons, path.join(wow, '_classic_beta_', 'Interface', 'AddOns'));
  assert.equal(found[0].forever, true);
  assert.equal(found[0].version, '1.60.1.70205');
});

test('Windows: default Program Files location without product.db, confirmed by .build.info', () => {
  const t = tmpDir();
  const drive = path.join(t, 'C');
  wowRoot(path.join(drive, 'Program Files (x86)', 'World of Warcraft'), ['_classic_beta_', '_retail_']);
  const found = detect({ clientFolder: '_classic_beta_' }, env({ platform: 'win32', drives: [drive] }));
  assert.equal(found.length, 1);
  assert.equal(found[0].forever, true);
  assert.equal(found[0].label, 'common location');
});

test('Windows: Battle.net.config default path and a renamed launch folder via config', () => {
  const t = tmpDir();
  const appData = path.join(t, 'AppData');
  const lib = path.join(t, 'X', 'Blizzard');
  wowRoot(path.join(lib, 'World of Warcraft'), ['_forever_'], { buildInfo: false });
  writeTree(appData, { 'Battle.net/Battle.net.config': JSON.stringify({ Client: { Install: { DefaultInstallPath: lib } } }) });
  // _forever_ is always looked at, whatever client folder the config names.
  for (const clientFolder of ['_classic_beta_', '_forever_']) {
    const found = detect({ clientFolder }, env({ platform: 'win32', appData }));
    assert.equal(found.length, 1, clientFolder);
    assert.equal(found[0].forever, false, 'not confirmed without version info');
  }
  assert.equal(detect({ clientFolder: '_classic_beta_' }, env({ platform: 'win32', appData }))[0].addons, path.join(lib, 'World of Warcraft', '_forever_', 'Interface', 'AddOns'));
});

test('several installs: the _forever_ one is listed first, and an unconfirmed one still beats other folders', () => {
  const t = tmpDir();
  const drive = path.join(t, 'C');
  const wow = path.join(drive, 'Program Files (x86)', 'World of Warcraft');
  wowRoot(wow, ['_classic_beta_', '_forever_'], { buildInfo: false });
  const found = detect({ clientFolder: '_classic_beta_' }, env({ platform: 'win32', drives: [drive] }));
  assert.deepEqual(found.map((c) => path.basename(c.clientDir)), ['_forever_', '_classic_beta_']);
});

test('Steam Deck: Proton prefix on internal storage and another on the SD card', () => {
  const home = tmpDir();
  const runMedia = tmpDir();
  // Internal: Battle.net added as a non-Steam game, with product.db inside the prefix.
  const pfx = path.join(home, '.local/share/Steam/steamapps/compatdata/3141592653/pfx');
  const wow = path.join(pfx, 'drive_c/Program Files (x86)/World of Warcraft');
  wowRoot(wow, ['_classic_beta_'], { buildInfo: false });
  writeTree(pfx, {});
  fs.mkdirSync(path.join(pfx, 'drive_c/ProgramData/Battle.net/Agent'), { recursive: true });
  fs.writeFileSync(path.join(pfx, 'drive_c/ProgramData/Battle.net/Agent/product.db'),
    encodeProductDb([{ code: 'wow_classic_beta', location: 'C:/Program Files (x86)/World of Warcraft', folder: '_classic_beta_', version: '1.60.1.70205' }]));
  // SD card library: /run/media/deck/SDCARD/steamapps/compatdata/<id>/pfx, lowercase interface/addons.
  const sdPfx = path.join(runMedia, 'deck/SDCARD/steamapps/compatdata/2718281828/pfx');
  wowRoot(path.join(sdPfx, 'drive_c/Program Files (x86)/World of Warcraft'), ['_classic_beta_'], { interfaceName: 'interface', addonsName: 'Addons' });

  const found = detect({ clientFolder: '_classic_beta_' }, env({ home, runMedia }));
  assert.equal(found.length, 2);
  const internal = found.find((c) => c.label.includes('3141592653'));
  const sd = found.find((c) => c.label.includes('2718281828'));
  assert.ok(internal && sd);
  assert.equal(internal.forever, true);
  assert.equal(internal.addons, path.join(wow, '_classic_beta_', 'Interface', 'AddOns'));
  assert.equal(sd.forever, true, 'confirmed by .build.info');
  assert.match(sd.addons, /interface[\\/]Addons$/, 'existing lowercase folders are reused');
  assert.match(sd.label, /SDCARD/);
});

test('Steam Deck: Lutris and Heroic prefixes', () => {
  const home = tmpDir();
  wowRoot(path.join(home, 'Games/battlenet/drive_c/Program Files (x86)/World of Warcraft'), ['_classic_beta_']);
  wowRoot(path.join(home, 'Games/Heroic/Prefixes/default/Battlenet/drive_c/Program Files/World of Warcraft'), ['_classic_beta_']);
  const found = detect({ clientFolder: '_classic_beta_' }, env({ home }));
  assert.deepEqual(found.map((c) => c.label.split(' ')[0]).sort(), ['Heroic', 'Lutris']);
});

test('Steam Deck: extra library from libraryfolders.vdf', () => {
  const home = tmpDir();
  const extra = tmpDir();
  writeTree(home, { '.local/share/Steam/steamapps/libraryfolders.vdf': `"libraryfolders"\n{\n "0" { "path" "${home}/.local/share/Steam" }\n "1" { "path" "${extra.replace(/\\/g, '\\\\')}" }\n}\n` });
  wowRoot(path.join(extra, 'steamapps/compatdata/99/pfx/drive_c/Program Files (x86)/World of Warcraft'), ['_classic_beta_']);
  const found = detect({ clientFolder: '_classic_beta_' }, env({ home }));
  assert.equal(found.length, 1);
  assert.match(found[0].label, /app 99/);
});

test('Wine path mapping and case-insensitive resolution', () => {
  const pfx = tmpDir();
  fs.mkdirSync(path.join(pfx, 'drive_c/program files (x86)/World Of Warcraft'), { recursive: true });
  assert.equal(winePath(pfx, 'C:/Program Files (x86)/World of Warcraft'), path.join(pfx, 'drive_c/program files (x86)/World Of Warcraft'));
  assert.equal(winePath(pfx, 'D:/Games/WoW'), path.join(pfx, 'dosdevices/d:/Games/WoW'));
  const r = resolveFold(pfx, 'DRIVE_C', 'Program Files (x86)', 'nope');
  assert.equal(r.exists, false);
  assert.equal(r.path, path.join(pfx, 'drive_c/program files (x86)/nope'));
});

test('Steam Deck: ~/.steam/steam symlinked to ~/.local/share/Steam gives one candidate, not two', () => {
  const home = tmpDir();
  const steam = path.join(home, '.local/share/Steam');
  wowRoot(path.join(steam, 'steamapps/compatdata/3141592653/pfx/drive_c/Program Files (x86)/World of Warcraft'), ['_classic_beta_']);
  fs.mkdirSync(path.join(home, '.steam'), { recursive: true });
  // A junction on Windows behaves like the directory symlink SteamOS uses.
  fs.symlinkSync(steam, path.join(home, '.steam/steam'), 'junction');
  const found = detect({ clientFolder: '_classic_beta_' }, env({ home }));
  assert.equal(found.length, 1);
  assert.equal(found[0].forever, true);
});
