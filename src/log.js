// @ts-check
// Output. On a real terminal: colour and symbols. Redirected to a file or run from a
// script: plain ASCII lines ("WARNING: ...", "[item] ...") that are easy to grep.
import { colorOn, paint, sym } from './ui.js';

let verbose = false;

/** @param {boolean} v */
export function setVerbose(v) {
  verbose = v;
}

/** @param {string} msg */
export function info(msg) {
  process.stdout.write(msg + '\n');
}

/** @param {string} msg */
export function warn(msg) {
  if (colorOn()) process.stdout.write(`${paint(['bold', 'yellow'], sym().warn)} ${paint('yellow', msg)}\n`);
  else process.stdout.write('WARNING: ' + msg + '\n');
}

/** @param {string} msg */
export function error(msg) {
  if (colorOn()) process.stderr.write(`${paint(['bold', 'red'], sym().fail)} ${paint('red', msg)}\n`);
  else process.stderr.write('ERROR: ' + msg + '\n');
}

/** @param {string} msg */
export function debug(msg) {
  if (verbose) process.stdout.write(paint('dim', '  . ' + msg) + '\n');
}

/**
 * A logger for one addon: a titled block on a terminal, "[id] ..." lines elsewhere.
 * @param {string} id @param {string} title
 */
export function scoped(id, title) {
  const tag = `[${id}]`;
  return {
    /** Start of a block. @param {string} [note] */
    head(note = '') {
      if (colorOn()) info(`\n${paint(['bold', 'cyan'], sym().pointer)} ${paint('bold', title)}${note ? '  ' + paint('dim', note) : ''}`);
    },
    /** @param {string} msg */
    info(msg) {
      info(colorOn() ? '  ' + paint('dim', msg) : `${tag} ${msg}`);
    },
    /** Something finished. @param {string} msg */
    ok(msg) {
      info(colorOn() ? `  ${paint('green', sym().ok)} ${msg}` : `${tag} ${msg}`);
    },
    /** @param {string} msg */
    warn(msg) {
      warn(colorOn() ? msg : `${tag} ${msg}`);
    },
    /** @param {string} msg */
    debug(msg) {
      debug(colorOn() ? msg : `${tag} ${msg}`);
    },
    /**
     * One status line for the addon (used in reports).
     * @param {'ok' | 'warn' | 'fail' | 'skip'} kind @param {string} msg
     */
    row(kind, msg) {
      if (!colorOn()) {
        if (kind === 'warn') warn(`${tag} ${msg}`);
        else if (kind === 'fail') error(`${tag} ${msg}`);
        else info(`${tag} ${msg}`);
        return;
      }
      const s = sym();
      const mark = { ok: paint('green', s.ok), warn: paint('yellow', s.warn), fail: paint('red', s.fail), skip: paint('dim', s.off) }[kind];
      (kind === 'fail' ? error : info)(kind === 'fail' ? `${title}: ${msg}` : `  ${mark} ${paint('bold', title)}  ${msg}`);
    },
  };
}

/** Human-readable byte count, e.g. "1.40 GB". @param {number} n */
export function bytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return i === 0 ? `${n} B` : `${n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0)} ${units[i]}`;
}
