// @ts-check
// Tiny terminal prompts with no dependencies: a pick-one list and a checkbox list.
// With a real keyboard (a TTY that supports raw mode) they redraw in place and use
// the arrow keys; otherwise they fall back to numbered line input through io.ask,
// which also works over pipes and in unusual terminals.
import readline from 'node:readline';
import { colorOn, paint, pad, vlen, sym, truncate, columns } from './ui.js';

/**
 * @typedef {{ value: string, label: string, hint?: string, checked?: boolean }} Option
 * @typedef {object} IO
 * @property {NodeJS.ReadStream & { setRawMode?: (on: boolean) => unknown }} input
 * @property {NodeJS.WriteStream} output
 * @property {(question: string) => Promise<string>} ask  one line of input, for the numbered fallback
 */

/** Whether the arrow-key UI can be used. @param {IO} io */
export const hasKeys = (io) => !!io.input.isTTY && typeof io.input.setRawMode === 'function';

/** @param {boolean} multi */
const helpLine = (multi) => {
  const s = sym();
  const keys = `${s.up}/${s.down} move`;
  return paint('dim', multi ? `${keys}   Space tick   a all/none   Enter confirm   Esc cancel` : `${keys}   Enter choose   Esc back`);
};

/**
 * @param {string} title @param {Option[]} options @param {boolean} multi @param {number} cursor @param {Set<string>} on
 * @returns {string[]}
 */
function frame(title, options, multi, cursor, on) {
  const s = sym();
  const width = Math.max(...options.map((o) => vlen(o.label)));
  const lines = ['', ...title.split('\n').map((l) => paint('bold', l)), ''];
  options.forEach((o, i) => {
    const here = i === cursor;
    const ptr = here ? paint('cyan', s.pointer) : ' ';
    const mark = multi ? (on.has(o.value) ? paint('green', s.check) : paint('dim', s.uncheck)) + ' ' : '';
    const label = here ? paint(['bold', 'cyan'], pad(o.label, width)) : pad(o.label, width);
    lines.push(`  ${ptr} ${mark}${label}${o.hint ? '  ' + paint('dim', o.hint) : ''}`);
  });
  lines.push('', '  ' + helpLine(multi));
  return lines;
}

/**
 * Arrow-key list. Resolves with the chosen values, or null when cancelled.
 * @param {string} title @param {Option[]} options @param {boolean} multi @param {IO} io
 * @returns {Promise<string[] | null>}
 */
function interactive(title, options, multi, io) {
  const { input, output } = io;
  const on = new Set(options.filter((o) => o.checked).map((o) => o.value));
  let cursor = 0;
  let drawn = 0;
  const draw = () => {
    // One screen row per line: a wrapped line would make the cursor-up below undershoot.
    const max = (output.columns || columns() + 1) - 1;
    const lines = frame(title, options, multi, cursor, on).map((l) => truncate(l, max));
    if (drawn) output.write(`\x1b[${drawn}A`);
    for (const l of lines) output.write(`\x1b[2K${l}\n`);
    // A shorter frame than the last one would leave stale lines behind.
    for (let i = lines.length; i < drawn; i++) output.write('\x1b[2K\n');
    drawn = Math.max(drawn, lines.length);
  };

  return new Promise((resolve) => {
    readline.emitKeypressEvents(input);
    const wasRaw = !!input.isRaw;
    input.setRawMode?.(true);
    input.resume();
    if (colorOn()) output.write('[?25l'); // hide the cursor while a list is showing
    /** @param {string[] | null} result */
    const done = (result) => {
      input.off('keypress', onKey);
      if (colorOn()) output.write('[?25h');
      input.setRawMode?.(wasRaw);
      input.pause();
      resolve(result);
    };
    /** @param {string | undefined} str @param {readline.Key} key */
    const onKey = (str, key) => {
      const name = key?.name;
      if ((key?.ctrl && name === 'c') || name === 'escape' || str === 'q') return done(null);
      if (name === 'up' || str === 'k') cursor = (cursor + options.length - 1) % options.length;
      else if (name === 'down' || str === 'j') cursor = (cursor + 1) % options.length;
      else if (name === 'return' || name === 'enter') {
        return done(multi ? options.filter((o) => on.has(o.value)).map((o) => o.value) : [options[cursor].value]);
      } else if (multi && name === 'space') {
        const v = options[cursor].value;
        if (!on.delete(v)) on.add(v);
      } else if (multi && str === 'a') {
        if (on.size === options.length) on.clear();
        else options.forEach((o) => on.add(o.value));
      } else if (!multi && str && /^[1-9]$/.test(str) && +str <= options.length) {
        return done([options[+str - 1].value]);
      }
      draw();
    };
    input.on('keypress', onKey);
    draw();
  });
}

/**
 * Numbered fallback.
 * @param {string} title @param {Option[]} options @param {boolean} multi @param {IO} io
 * @returns {Promise<string[] | null>}
 */
async function numbered(title, options, multi, io) {
  const on = new Set(options.filter((o) => o.checked).map((o) => o.value));
  for (;;) {
    const out = [title, ''];
    options.forEach((o, i) => out.push(`  ${String(i + 1).padStart(2)}) ${multi ? (on.has(o.value) ? '[x] ' : '[ ] ') : ''}${o.label}${o.hint ? `  - ${o.hint}` : ''}`));
    io.output.write(out.join('\n') + '\n');
    const ans = (await io.ask(multi ? 'Numbers to toggle (e.g. "1 3"), Enter to confirm, q to cancel: ' : `Choose 1-${options.length} (q to go back): `)).trim();
    if (/^q$/i.test(ans)) return null;
    if (!multi) {
      const n = Number(ans);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return [options[n - 1].value];
      continue;
    }
    if (ans === '') return options.filter((o) => on.has(o.value)).map((o) => o.value);
    for (const tok of ans.split(/[\s,]+/)) {
      const n = Number(tok);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) {
        const v = options[n - 1].value;
        if (!on.delete(v)) on.add(v);
      }
    }
  }
}

/**
 * Pick one option. Resolves with its value, or null when the user backs out.
 * @param {string} title @param {Option[]} options @param {IO} io @returns {Promise<string | null>}
 */
export async function choose(title, options, io) {
  const r = await (hasKeys(io) ? interactive(title, options, false, io) : numbered(title, options, false, io));
  return r ? r[0] : null;
}

/**
 * Tick any number of options. Resolves with the ticked values, or null when cancelled.
 * @param {string} title @param {Option[]} options @param {IO} io @returns {Promise<string[] | null>}
 */
export function checklist(title, options, io) {
  return hasKeys(io) ? interactive(title, options, true, io) : numbered(title, options, true, io);
}
