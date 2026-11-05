// The interactive menu: key handling in tui.js, the menu loop in menu.js, and the
// rules in cli.main for when the menu opens at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { tmpDir } from './helpers.ts';
import { choose, checklist } from '../src/ui/prompts.ts';
import { runMenu } from '../src/menu/menu.ts';
import { main } from '../src/cli.ts';
import { saveConfig, loadConfig, DEFAULT_CONFIG } from '../src/config/config.ts';
import type { Config } from '../src/config/config.ts';
import type { IO } from '../src/ui/prompts.ts';

const KEY = { up: '\x1b[A', down: '\x1b[B', enter: '\r', space: ' ', esc: '\x1b' };
const tick = () => new Promise((r) => setImmediate(r));

/** A terminal that supports raw keys. */
function keyboard() {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: () => unknown };
  input.isTTY = true;
  input.setRawMode = () => input;
  const output = new PassThrough();
  let drawn = '';
  output.on('data', (d: Buffer) => (drawn += d)); // flowing, and kept so a test can check what was shown
  const press = async (keys: string[]) => {
    for (const k of keys) {
      await tick();
      input.write(k);
    }
  };
  const io: IO = { input: input as unknown as NodeJS.ReadStream, output: output as unknown as NodeJS.WriteStream, ask: async () => { throw new Error('should not ask with a keyboard'); } };
  return { io, press, text: () => drawn };
}

/** No keyboard (a pipe): prompts fall back to numbered lines, answered from a script. */
function scripted(answers: string[]) {
  const asked: string[] = [];
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const output = new PassThrough();
  output.resume();
  const io: IO = {
    input, output: output as unknown as NodeJS.WriteStream,
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

/** Config with an addons folder and a source that has nothing, so nothing is downloaded. */
function setup(cfg: Partial<Config> = {}) {
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

test('menu: ticking Spoken asks which voice packs, and the answers are saved', async () => {
  const { configDir, deps } = setup({ selected: ['nodesight'] });
  // Select addons, tick Spoken (1), confirm; the packs prompt: toggle Zones off, confirm; Exit.
  const s = scripted(['2', '1', '', '1', '', '6']);
  await runMenu({}, deps, s.io);
  const cfg = loadConfig(configDir);
  assert.equal(cfg.include_zones, false);
  assert.equal(cfg.include_books, true);
  assert.deepEqual(cfg.selected, ['spoken', 'nodesight']);
  assert.equal(s.left(), 0);
});

test('menu: changing another addon does not drag you through the Spoken voice packs', async () => {
  const { configDir, deps } = setup(); // Spoken is already selected
  // Select addons, tick DialogKey (5), confirm; straight back to the menu; Exit. Any packs prompt would eat an answer and fail.
  const s = scripted(['2', '5', '', '6']);
  await runMenu({}, deps, s.io);
  assert.ok(loadConfig(configDir).selected.includes('dialogkey'));
  assert.equal(s.left(), 0);
  assert.ok(!s.asked.some((q) => /voice packs/i.test(q)));
});

test('menu: the Spoken voice packs can be changed later under Settings', async () => {
  const { configDir, deps } = setup();
  // Settings (5) > Spoken voice packs (3): toggle Books off, confirm; Settings > Back (4); Exit.
  const s = scripted(['5', '3', '2', '', '4', '6']);
  await runMenu({}, deps, s.io);
  const cfg = loadConfig(configDir);
  assert.equal(cfg.include_books, false);
  assert.equal(cfg.include_zones, true);
  assert.equal(s.left(), 0);
});

/** Wait until a condition holds, so a key is never pressed before the prompt that should get it. */
async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for the menu');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('menu with real keys: tick one addon with Space, confirm with Enter, and land back on the menu', async () => {
  const { configDir, deps } = setup();
  const k = keyboard();
  const run = runMenu({}, deps, k.io);
  await until(() => k.text().includes('What would you like to do?'));
  await k.press([KEY.down, KEY.enter]); // Choose which addons I want
  await until(() => k.text().includes('Which addons do you want?'));
  await k.press([KEY.down, KEY.down, KEY.down, KEY.down, KEY.space]); // DialogKey is the fifth item
  await k.press([KEY.enter]);
  await until(() => loadConfig(configDir).selected.includes('dialogkey'));
  assert.ok(!k.text().includes('Spoken voice packs'), 'confirming did not open the Spoken options');
  await until(() => (k.text().match(/What would you like to do?/g) ?? []).length >= 2); // back on the main menu
  await k.press(['q']);
  assert.equal(await run, 0);
  assert.equal(k.io.input.listenerCount('keypress'), 0, 'no prompt is left listening');
});

test('menu with real keys: looks again on a timer and announces a new update once', async () => {
  const { deps } = setup({ selected: ['nodesight'] });
  let phase = 0; // 0: nothing is published yet, 1: NodeSight 2.0.0 appears
  const release = { version: '2.0.0', tag: 'v2.0.0', source: 'Fake', asset: { name: 'NodeSight-2.0.0.zip', url: 'http://x/n.zip', size: 1000, sha256: null } };
  const notes: string[][] = [];
  const watched = { ...deps, source: { name: 'Fake', latest: async () => (phase ? release : null) }, notify: (t: string, b: string) => { notes.push([t, b]); } };
  const k = keyboard();
  const run = runMenu({}, watched, k.io, '', 60);
  const looks = () => (k.text().match(/What would you like to do\?/g) ?? []).length;
  try {
    await until(() => looks() >= 1);
    assert.equal(notes.length, 0, 'the first look announces nothing');
    phase = 1;
    await until(() => notes.length === 1);
    assert.match(notes[0][1], /NodeSight 2\.0\.0/);
    assert.ok(k.text().includes('\x07'), 'the terminal bell rang');
    // Later looks find the same update and stay quiet.
    const seen = looks();
    await until(() => looks() >= seen + 2);
    assert.equal(notes.length, 1, 'the same update is not announced again');
  } finally {
    await k.press(['q']); // never leave the timer loop running
  }
  assert.equal(await run, 0);
  assert.equal(k.io.input.listenerCount('keypress'), 0, 'no prompt is left listening');
});

test('menu refresh asks the source to look again (it caches what it fetched)', async () => {
  const { deps } = setup({ selected: ['nodesight'] });
  let invalidated = 0;
  const watched = { ...deps, source: { name: 'Fake', latest: async () => null, invalidate: () => { invalidated++; } } };
  const k = keyboard();
  const run = runMenu({}, watched, k.io, '', 40);
  const looks = () => (k.text().match(/What would you like to do\?/g) ?? []).length;
  try {
    await until(() => looks() >= 3);
  } finally {
    await k.press(['q']);
  }
  await run;
  assert.ok(invalidated >= 2, 'every refresh invalidated the source, the first draw did not');
  assert.ok(invalidated <= looks() - 1);
});

test('menu refresh offers a newer version of this tool: yes updates and restarts, no is remembered', async () => {
  const { deps } = setup({ selected: ['nodesight'] });
  const calls = { check: 0, apply: 0 };
  const asked: string[] = [];
  const mk = (answer: string) => ({
    ...deps, ask: async (q: string) => { asked.push(q); return answer; },
    selfUpdate: { check: async () => { calls.check++; return '9.9.9'; }, apply: async () => { calls.apply++; } },
  });
  const looks = (k: ReturnType<typeof keyboard>) => (k.text().match(/What would you like to do\?/g) ?? []).length;
  for (const answer of ['n', 'y']) {
    const k = keyboard();
    const io = { ...k.io, ask: async (q: string) => { asked.push(q); return answer; } };
    const run = runMenu({}, mk(answer), io, '2.0.0', 40);
    try {
      await until(() => looks(k) >= 4); // several refreshes
    } finally {
      await k.press(['q']);
    }
    await run;
    assert.ok(k.text().includes(''), 'the bell rang');
  }
  assert.equal(calls.apply, 1, 'only the yes updated');
  assert.equal(asked.filter((q) => /9\.9\.9/.test(q)).length, 2, 'asked once per run: a no is remembered, a yes leaves the loop to apply');
  assert.ok(calls.check >= 4);
});

test('menu without a keyboard never refreshes', async () => {
  const { deps } = setup();
  const s = scripted(['6']);
  await runMenu({}, deps, s.io, '', 10);
  assert.equal(s.asked.length, 1);
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
