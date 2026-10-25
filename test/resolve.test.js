// @ts-check
// Which AddOns folder is used when several WoW installs are found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers.js';
import { resolveAddons, UsageError } from '../src/app.js';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.js';

/** A Windows PC with the given client folders in each WoW root. @param {Record<string, string[]>} roots root (relative to the drive) -> client folders */
function pc(roots) {
  const t = tmpDir();
  const drive = path.join(t, 'C');
  for (const [root, clients] of Object.entries(roots)) {
    for (const c of clients) fs.mkdirSync(path.join(drive, root, c, 'Interface', 'AddOns'), { recursive: true });
  }
  const env = { platform: /** @type {const} */ ('win32'), home: '/nonexistent', drives: [drive], appData: null, runMedia: '/nonexistent', registryInstallDirs: () => [] };
  const configDir = path.join(t, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  return { drive, env, configDir, cfg: { ...DEFAULT_CONFIG } };
}

const R1 = 'Program Files (x86)/World of Warcraft';
const R2 = 'Games/World of Warcraft';

test('default client folder is _forever_', () => {
  assert.equal(DEFAULT_CONFIG.client_folder, '_forever_');
});

test('with several client folders in one install, the _forever_ one is used without asking', async () => {
  const p = pc({ [R1]: ['_classic_beta_', '_forever_', '_retail_'] });
  const deps = /** @type {any} */ ({ env: p.env, configDir: p.configDir, tty: true, ask: async () => { throw new Error('should not ask'); } });
  // Even a config that still names the old folder finds it.
  for (const client_folder of ['_forever_', '_classic_beta_']) {
    const got = await resolveAddons({}, deps, { ...p.cfg, client_folder });
    assert.equal(got, path.join(p.drive, R1, '_forever_', 'Interface', 'AddOns'));
  }
});

test('with the _forever_ folder in two installs, it asks, and Enter takes the first', async () => {
  const p = pc({ [R1]: ['_forever_'], [R2]: ['_forever_'] });
  /** @type {string[]} */
  const asked = [];
  const deps = /** @type {any} */ ({ env: p.env, configDir: p.configDir, tty: true, ask: async (/** @type {string} */ q) => { asked.push(q); return ''; } });
  const got = await resolveAddons({}, deps, p.cfg);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Enter = 1/);
  assert.ok(got.endsWith(path.join('_forever_', 'Interface', 'AddOns')));
  assert.equal(loadConfig(p.configDir).addons_path, got, 'the choice is remembered');
});

test('several installs and no way to ask is an error that lists them', async () => {
  const p = pc({ [R1]: ['_forever_'], [R2]: ['_forever_'] });
  const deps = /** @type {any} */ ({ env: p.env, configDir: p.configDir, tty: false });
  await assert.rejects(resolveAddons({ yes: true }, deps, p.cfg), (/** @type {Error} */ e) => e instanceof UsageError && /several AddOns folders/.test(e.message));
  assert.equal(await resolveAddons({ addons: path.join(p.drive, R2, '_forever_', 'Interface', 'AddOns') }, deps, p.cfg), path.join(p.drive, R2, '_forever_', 'Interface', 'AddOns'), '--addons always wins');
});

test('a number is still accepted at the prompt, and nonsense is asked again', async () => {
  const p = pc({ [R1]: ['_forever_'], [R2]: ['_forever_'] });
  const answers = ['9', 'x', '2'];
  const deps = /** @type {any} */ ({ env: p.env, configDir: p.configDir, tty: true, ask: async () => answers.shift() });
  const got = await resolveAddons({}, deps, p.cfg);
  assert.equal(answers.length, 0);
  assert.ok(got.includes('World of Warcraft'));
});
