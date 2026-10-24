// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paint, stripAnsi, vlen, pad, truncate, banner, sym, colorOn, unicodeOn } from '../src/ui.js';
import { rowFor } from '../src/menu.js';
import { GROUPS } from '../src/catalog.js';

/** Run with environment variables set, then put them back. @param {Record<string, string | undefined>} env @param {() => void} fn */
function withEnv(env, fn) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test('colour is off for NO_COLOR and pipes, on for FORCE_COLOR', () => {
  withEnv({ NO_COLOR: '1', FORCE_COLOR: undefined }, () => assert.equal(paint('red', 'x'), 'x'));
  withEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => assert.equal(paint('red', 'x'), '\x1b[31mx\x1b[39m'));
  withEnv({ NO_COLOR: undefined, FORCE_COLOR: undefined }, () => assert.equal(colorOn(), !!process.stdout.isTTY && process.env.TERM !== 'dumb'));
});

test('widths ignore colour codes, and truncation keeps them balanced', () => {
  withEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => {
    const s = paint('green', 'hello world');
    assert.equal(vlen(s), 11);
    assert.equal(stripAnsi(pad(s, 15)), 'hello world    ');
    const cut = truncate(s, 8);
    assert.equal(vlen(cut), 8);
    assert.ok(cut.endsWith('\x1b[0m'), 'colour reset after a cut');
    assert.equal(truncate(s, 20), s, 'short lines are untouched');
  });
});

test('ASCII mode (WFE_ASCII) uses plain symbols and a plain banner', () => {
  withEnv({ WFE_ASCII: '1', NO_COLOR: '1' }, () => {
    assert.equal(unicodeOn(), false);
    assert.equal(sym().pointer, '>');
    const b = banner('Title', 'v1');
    assert.match(b[0], /^\+-+\+$/);
    assert.ok(b.every((l) => vlen(l) === vlen(b[0])), 'every banner row is the same width');
  });
  withEnv({ WFE_ASCII: undefined, NO_COLOR: '1' }, () => {
    const b = banner('Title', 'v1');
    assert.ok(b.every((l) => vlen(l) === vlen(b[0])));
  });
});

test('dashboard rows describe each addon in plain words', () => {
  const g = GROUPS[1]; // luzenna-forever
  const item = /** @type {any} */ ({ id: 'luzenna-forever', group: 'luzenna-forever', kind: 'addon' });
  const plan = (/** @type {any} */ o) => /** @type {any} */ ({ item, release: { version: '1.0.0', asset: { size: 14000 } }, installed: null, act: false, status: 'current', ...o });
  assert.equal(rowFor(g, false, []).state, 'off');
  assert.equal(rowFor(g, true, [plan({ installed: '1.0.0' })]).state, 'ok');
  assert.equal(rowFor(g, true, [plan({ status: 'not-installed', act: true })]).state, 'new');
  const up = rowFor(g, true, [plan({ status: 'outdated', act: true, installed: '0.1.0' })]);
  assert.equal(up.state, 'update');
  assert.match(stripAnsi(up.note), /update available.*1\.0\.0/);
  assert.equal(rowFor(g, true, [plan({ status: 'error' })]).state, 'problem');
});
