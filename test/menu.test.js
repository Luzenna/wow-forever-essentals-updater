// @ts-check
// The interactive menu: key handling in tui.js, the menu loop in menu.js, and the
// rules in cli.main for when the menu opens at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { tmpDir } from './helpers.js';
import { choose, checklist } from '../src/tui.js';
import { runMenu } from '../src/menu.js';
import { main } from '../src/cli.js';
import { saveConfig, loadConfig, DEFAULT_CONFIG } from '../src/config.js';

const KEY = { up: '\x1b[A', down: '\x1b[B', enter: '\r', space: ' ', esc: '\x1b' };
const tick = () => new Promise((r) => setImmediate(r));

/** A terminal that supports raw keys. */
function keyboard() {
  const input = /** @type {any} */ (new PassThrough());
  input.isTTY = true;
  input.setRawMode = () => input;
  const output = /** @type {any} */ (new PassThrough());
  output.resume(); // discard what is drawn
  /** @param {string[]} keys */
  const press = async (keys) => {
    for (const k of keys) {
      await tick();
      input.write(k);
    }
  };
  /** @type {import('../src/tui.js').IO} */
  const io = { input, output, ask: async () => { throw new Error('should not ask with a keyboard'); } };
  return { io, press };
}

/** No keyboard (a pipe): prompts fall back to numbered lines, answered from a script. @param {string[]} answers */
function scripted(answers) {
  const asked = /** @type {string[]} */ ([]);
  const input = /** @type {any} */ (new PassThrough());
  const output = /** @type {any} */ (new PassThrough());
  output.resume();
  /** @type {import('../src/tui.js').IO} */
  const io = {
    input, output,
    ask: async (q) => {
      asked.push(q);
      const a = answers.shift();
      if (a === undefined) throw new Error(`unexpected question: ${q}`);
      return a;
    },
  };
  return { io, asked, left: () => answers.length };
}

const OPTS = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }];

test('choose: arrow keys move, Enter picks, q backs out', async () => {
  let k = keyboard();
  let p = choose('t', OPTS, k.io);
  await k.press([KEY.down, KEY.down, KEY.enter]);
  assert.equal(await p, 'c');

  k = keyboard();
  p = choose('t', OPTS, k.io);
  await k.press([KEY.up, KEY.enter]); // wraps to the last
  assert.equal(await p, 'c');

  k = keyboard();
  p = choose('t', OPTS, k.io);
  await k.press(['2']);
  assert.equal(await p, 'b', 'digits pick directly');

  k = keyboard();
  p = choose('t', OPTS, k.io);
  await k.press(['q']);
  assert.equal(await p, null);
});

test('checklist: space toggles, a flips all, Enter confirms, Esc cancels', async () => {
  let k = keyboard();
  let p = checklist('t', [{ ...OPTS[0], checked: true }, OPTS[1], OPTS[2]], k.io);
  await k.press([KEY.space, KEY.down, KEY.down, KEY.space, KEY.enter]); // a off, c on
  assert.deepEqual(await p, ['c']);

  k = keyboard();
  p = checklist('t', OPTS, k.io);
  await k.press(['a', KEY.enter]);
  assert.deepEqual(await p, ['a', 'b', 'c']);
  k = keyboard();
  p = checklist('t', OPTS, k.io);
  await k.press(['a', 'a', KEY.enter]);
  assert.deepEqual(await p, [], 'second a clears');

  k = keyboard();
  p = checklist('t', OPTS, k.io);
  await k.press([KEY.space, KEY.esc]);
  assert.equal(await p, null);
});

test('without a keyboard the prompts take numbers', async () => {
  const s = scripted(['9', 'x', '2']);
  assert.equal(await choose('t', OPTS, s.io), 'b', 'out-of-range and junk are asked again');
  const s2 = scripted(['1 3', '1', '']);
  // "1 3" flips a off and c on; "1" flips a back on; Enter confirms.
  assert.deepEqual(await checklist('t', [{ ...OPTS[0], checked: true }, OPTS[1], OPTS[2]], s2.io), ['a', 'c']);
});

/** Config with an addons folder and a source that has nothing, so nothing is downloaded. @param {Partial<import('../src/config.js').Config>} [cfg] */
function setup(cfg = {}) {
  const home = tmpDir();
  const configDir = path.join(home, 'config');
  saveConfig(configDir, { ...DEFAULT_CONFIG, addons_path: path.join(home, 'AddOns'), ...cfg });
  const deps = { source: { name: 'Fake', latest: async () => null }, configDir, cacheDir: path.join(home, 'cache'), runningWow: () => [], tty: false };
  return { configDir, deps };
}

test('menu: select addons saves the selection, exit ends the loop', async () => {
  const { configDir, deps } = setup();
  // main menu: 2 = Select addons; checklist: toggle 1 (Spoken off) and 3 (NodeSight off), confirm; main menu: 5 = Exit.
  const s = scripted(['2', '1 3', '', '6']);
  assert.equal(await runMenu({}, deps, s.io), 0);
  assert.deepEqual(loadConfig(configDir).selected, ['luzenna-forever', 'dialogueui']);
  assert.equal(s.left(), 0);
});

test('menu: Spoken asks which audio packs, and the answers are saved', async () => {
  const { configDir, deps } = setup();
  // Select addons, keep all four, then toggle Zones audio off; Exit.
  const s = scripted(['2', '', '1', '', '6']);
  await runMenu({}, deps, s.io);
  const cfg = loadConfig(configDir);
  assert.equal(cfg.include_zones, false);
  assert.equal(cfg.include_books, true);
  assert.equal(cfg.selected.length, 4);
});

test('menu: backing out of a list changes nothing, and a failing item does not close the menu', async () => {
  const { configDir, deps } = setup();
  const before = loadConfig(configDir);
  const failing = { ...deps, source: { name: 'Fake', latest: async () => { throw new Error('offline'); } }, configDir };
  // Select addons -> q; Status (3) lists the per-item errors; Update (1) fails; each waits for Enter; Exit.
  const s = scripted(['2', 'q', '4', '', '1', '', '6']);
  const code = await runMenu({ yes: true }, failing, s.io);
  assert.deepEqual(loadConfig(configDir), before);
  assert.equal(code, 1, 'the failed update is reflected in the exit code');
  assert.equal(s.left(), 0);
});

test('no command: a terminal gets the menu, --yes or a pipe gets update', async () => {
  const { deps } = setup({ selected: [] });
  const asked = scripted(['6']);
  assert.equal(await main([], { interactive: true, deps, io: asked.io }), 0);
  assert.equal(asked.asked.length, 1, 'the menu was shown');

  const none = scripted([]);
  assert.equal(await main(['--yes'], { interactive: true, deps, io: none.io }), 0);
  assert.equal(await main([], { interactive: false, deps, io: none.io }), 0);
  assert.equal(none.asked.length, 0, 'nothing was asked');

  await assert.rejects(main(['menu'], { interactive: false, deps }), /interactive terminal/);
});
