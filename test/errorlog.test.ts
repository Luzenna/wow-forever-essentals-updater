import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { logError, describeError, ERROR_LOG } from '../src/config/errorlog.ts';
import { tmpDir } from './helpers.ts';

test('logError appends one line per failure and names the cause of a fetch error', () => {
  const dir = tmpDir();
  const e = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
  assert.equal(describeError(e), 'fetch failed (ECONNRESET)');
  logError(dir, 'check baganator', e);
  logError(dir, 'check syndicator', new Error('two\nlines'));
  const lines = fs.readFileSync(path.join(dir, ERROR_LOG), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^\d{4}-\d\d-\d\dT.* check baganator: fetch failed \(ECONNRESET\)$/);
  assert.match(lines[1]!, /check syndicator: two lines$/);
});

test('logError never throws, even when the folder cannot be written', () => {
  const dir = tmpDir();
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  assert.doesNotThrow(() => logError(path.join(blocker, 'sub'), 'x', new Error('boom')));
});
