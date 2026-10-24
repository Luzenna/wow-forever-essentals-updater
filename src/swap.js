// @ts-check
// Moves new addon folders into AddOns as one transaction. Old folders are renamed
// into a backup dir first; any failure puts everything back. A journal lets the
// next run finish or undo a swap interrupted by a crash or power loss.
//
// Work dir layout (next to the real AddOns dir, on the same filesystem, so renames are atomic):
//   Interface/.wow-forever-essentals-updater/journal.json
//   Interface/.wow-forever-essentals-updater/bak-<id>/<Folder>
//   Interface/.wow-forever-essentals-updater/staging-<id>/...
import fs from 'node:fs';
import path from 'node:path';
import { findChild } from './detect/fold.js';

const WORK_DIR = '.wow-forever-essentals-updater';

/**
 * @typedef {{ kind: 'backup' | 'install', from: string, to: string }} Move
 * @typedef {{ bakDir: string, moves: Move[], committed: boolean }} Journal
 * @typedef {(from: string, to: string) => void} RenameFn
 */

/**
 * Interface/.wow-forever-essentals-updater for an AddOns folder. AddOns may be a symlink or
 * junction to another drive (a common way to save space on the Deck), so the
 * work dir sits next to its real location to keep renames on one filesystem.
 * @param {string} addons
 */
export function workDirFor(addons) {
  let real = path.resolve(addons);
  try {
    real = fs.realpathSync(real);
  } catch { /* not created yet */ }
  return path.join(path.dirname(real), WORK_DIR);
}

/** The work dir of spoken-updater, this tool's earlier name; an interrupted install may still be waiting there. @param {string} addons */
export function legacyWorkDirFor(addons) {
  return path.join(path.dirname(workDirFor(addons)), '.spoken-updater');
}

/** @param {number} ms */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * fs.renameSync with retries: on Windows, Defender or Explorer briefly holding
 * a handle on freshly extracted files makes renames fail with EPERM/EBUSY.
 * @type {RenameFn}
 */
export function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code ?? '';
      if (code === 'EXDEV') {
        throw new Error(`cannot move ${from} to ${to}: they are on different drives. Point --addons at the real AddOns folder.`);
      }
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw e;
      sleepSync(250 * 2 ** i); // ~8 s in total
    }
  }
}

/** Windows reports a folder or file another program holds open as one of these. @param {unknown} e */
const isBusy = (e) => ['EPERM', 'EBUSY', 'EACCES'].includes(/** @type {NodeJS.ErrnoException} */ (e)?.code ?? '');

/** Write the journal durably: temp file, fsync, rename. @param {string} workDir @param {Journal} j */
function writeJournal(workDir, j) {
  const f = path.join(workDir, 'journal.json');
  const fd = fs.openSync(f + '.tmp', 'w');
  try {
    fs.writeSync(fd, JSON.stringify(j, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(f + '.tmp', f);
}

/** Undo the moves of an uncommitted journal, newest first. @param {Journal} j @param {RenameFn} rename */
function rollback(j, rename) {
  const errors = [];
  for (const m of [...j.moves].reverse()) {
    try {
      if (m.kind === 'install') {
        // Only remove what we moved in: if the staged source is still there,
        // the rename never happened and m.to is not ours.
        if (!fs.existsSync(m.from)) fs.rmSync(m.to, { recursive: true, force: true });
      } else if (fs.existsSync(m.to) && !fs.existsSync(m.from)) {
        rename(m.to, m.from);
      }
    } catch (e) {
      errors.push(`${m.to}: ${/** @type {Error} */ (e).message}`);
    }
  }
  if (errors.length) throw new Error(`rollback incomplete, check these by hand:\n  ${errors.join('\n  ')}`);
}

/**
 * Swap `roots` (folders in staging) into `addons`. Existing folders with the same
 * name, matched case-insensitively, are replaced. Nothing else in AddOns is touched.
 * `remove` names folders to take out in the same transaction (retired folders
 * the new release replaces); they go to the backup too, so a failure restores them.
 * @param {{ addons: string, roots: { name: string, dir: string }[], remove?: string[], workDir?: string, rename?: RenameFn }} opts
 */
export function swapIn(opts) {
  const rename = opts.rename ?? renameRetry;
  const workDir = opts.workDir ?? workDirFor(opts.addons);
  fs.mkdirSync(opts.addons, { recursive: true });
  fs.readdirSync(opts.addons); // fail now if we can't see what's there
  const bakDir = path.join(workDir, `bak-${process.pid}-${Date.now()}`);
  fs.mkdirSync(bakDir, { recursive: true });
  /** @type {Journal} */
  const j = { bakDir, moves: [], committed: false };
  writeJournal(workDir, j);
  /** @param {Move} m */
  const move = (m) => {
    j.moves.push(m);
    writeJournal(workDir, j);
    rename(m.from, m.to);
  };
  /**
   * Put an existing folder into the backup. A folder some program is sitting in (a terminal
   * or editor whose current folder is inside it) can't be renamed on Windows, but what is
   * inside it can be moved out. Then the folder itself stays, empty.
   * @param {string} existing  folder name in AddOns
   */
  const backup = (existing) => {
    const from = path.join(opts.addons, existing), to = path.join(bakDir, existing);
    try {
      move({ kind: 'backup', from, to });
    } catch (e) {
      if (!isBusy(e)) throw e;
      j.moves.pop(); // that rename did not happen
      writeJournal(workDir, j);
      fs.mkdirSync(to, { recursive: true });
      for (const child of fs.readdirSync(from)) move({ kind: 'backup', from: path.join(from, child), to: path.join(to, child) });
    }
  };
  try {
    const installing = new Set(opts.roots.map((r) => r.name.toLowerCase()));
    for (const name of opts.remove ?? []) {
      if (installing.has(name.toLowerCase())) continue;
      const existing = findChild(opts.addons, name, { dirsOnly: true });
      if (existing) backup(existing);
    }
    for (const r of opts.roots) {
      const existing = findChild(opts.addons, r.name, { dirsOnly: true });
      if (existing) backup(existing);
      const target = path.join(opts.addons, r.name);
      if (existing && fs.existsSync(path.join(opts.addons, existing))) {
        // The folder is still there (empty, because it could not be renamed): fill it.
        for (const child of fs.readdirSync(r.dir)) move({ kind: 'install', from: path.join(r.dir, child), to: path.join(opts.addons, existing, child) });
      } else {
        move({ kind: 'install', from: r.dir, to: target });
      }
    }
    j.committed = true;
    writeJournal(workDir, j);
  } catch (e) {
    rollback(j, rename);
    fs.rmSync(path.join(workDir, 'journal.json'), { force: true });
    fs.rmSync(bakDir, { recursive: true, force: true });
    if (isBusy(e)) {
      const where = /** @type {NodeJS.ErrnoException} */ (e).path ?? opts.addons;
      throw new Error(`${where} is in use by another program. Close any terminal, editor or game that has this folder open, then run again. Nothing was changed.`);
    }
    throw e;
  }
  fs.rmSync(bakDir, { recursive: true, force: true });
  fs.rmSync(path.join(workDir, 'journal.json'), { force: true });
}

/** Whether an interrupted swap is waiting to be recovered. @param {string} workDir */
export const pendingJournal = (workDir) => fs.existsSync(path.join(workDir, 'journal.json'));

/**
 * Finish or undo a swap left behind by a crash, and remove its staging and
 * backup leftovers. Read-only when there is nothing to recover. Returns a
 * message when it did something.
 * @param {string} workDir @param {RenameFn} [rename]
 */
export function recover(workDir, rename = renameRetry) {
  const f = path.join(workDir, 'journal.json');
  if (!fs.existsSync(f)) return null;
  /** @type {Journal} */
  let j;
  try {
    j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!Array.isArray(j.moves)) throw new Error('no moves');
  } catch {
    throw new Error(`${f} is damaged. Check that your addon folders in AddOns look right ` +
      `(originals may be in ${workDir}), then delete ${f} and run again.`);
  }
  let msg;
  if (j.committed) {
    msg = 'finished cleaning up an interrupted install';
  } else {
    rollback(j, rename);
    msg = 'rolled back an interrupted install; the previous version is back in place';
  }
  fs.rmSync(j.bakDir, { recursive: true, force: true });
  fs.rmSync(f, { force: true });
  removeLeftovers(workDir);
  return msg;
}

/** Delete staging-* and bak-* dirs from earlier runs (only call while holding the lock). @param {string} workDir */
export function removeLeftovers(workDir) {
  if (!fs.existsSync(workDir) || pendingJournal(workDir)) return [];
  const gone = fs.readdirSync(workDir).filter((d) => /^(staging|bak)-/.test(d));
  for (const d of gone) fs.rmSync(path.join(workDir, d), { recursive: true, force: true });
  try {
    fs.rmdirSync(workDir);
  } catch { /* not empty */ }
  return gone;
}
