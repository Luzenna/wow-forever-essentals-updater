// Output. On a real terminal: colour and symbols. Redirected to a file or run from a
// script: plain ASCII lines ("WARNING: ...", "[item] ...") that are easy to grep.
import { colorOn, paint, sym } from './term.ts';

let verbose = false;

export function setVerbose(v: boolean) {
  verbose = v;
}

export function info(msg: string) {
  process.stdout.write(msg + '\n');
}

export function warn(msg: string) {
  if (colorOn()) process.stdout.write(`${paint(['bold', 'yellow'], sym().warn)} ${paint('yellow', msg)}\n`);
  else process.stdout.write('WARNING: ' + msg + '\n');
}

export function error(msg: string) {
  if (colorOn()) process.stderr.write(`${paint(['bold', 'red'], sym().fail)} ${paint('red', msg)}\n`);
  else process.stderr.write('ERROR: ' + msg + '\n');
}

export function debug(msg: string) {
  if (verbose) process.stdout.write(paint('dim', '  . ' + msg) + '\n');
}

/**
 * A logger for one addon: a titled block on a terminal, "[id] ..." lines elsewhere.
 */
export function scoped(id: string, title: string) {
  const tag = `[${id}]`;
  return {
    /** Start of a block. */
    head(note = '') {
      if (colorOn()) info(`\n${paint(['bold', 'cyan'], sym().pointer)} ${paint('bold', title)}${note ? '  ' + paint('dim', note) : ''}`);
    },
    info(msg: string) {
      info(colorOn() ? '  ' + paint('dim', msg) : `${tag} ${msg}`);
    },
    /** Something finished. */
    ok(msg: string) {
      info(colorOn() ? `  ${paint('green', sym().ok)} ${msg}` : `${tag} ${msg}`);
    },
    warn(msg: string) {
      warn(colorOn() ? msg : `${tag} ${msg}`);
    },
    debug(msg: string) {
      debug(colorOn() ? msg : `${tag} ${msg}`);
    },
    /**
     * One status line for the addon (used in reports).
     */
    row(kind: 'ok' | 'warn' | 'fail' | 'skip', msg: string) {
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

/** Human-readable byte count, e.g. "1.40 GB". */
export function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return i === 0 ? `${n} B` : `${n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0)} ${units[i]}`;
}
