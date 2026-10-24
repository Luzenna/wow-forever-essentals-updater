// @ts-check
// Tiny terminal prompts with no dependencies: a pick-one list and a checkbox list.
// With a real keyboard (a TTY that supports raw mode) they redraw in place and use
// the arrow keys; otherwise they fall back to numbered line input through io.ask,
// which also works over pipes and in unusual terminals.
import readline from 'node:readline';

/**
 * @typedef {{ value: string, label: string, hint?: string, checked?: boolean }} Option
 * @typedef {object} IO
 * @property {NodeJS.ReadStream & { setRawMode?: (on: boolean) => unknown }} input
 * @property {NodeJS.WriteStream} output
 * @property {(question: string) => Promise<string>} ask  one line of input, for the numbered fallback
 */

/** Whether the arrow-key UI can be used. @param {IO} io */
export const hasKeys = (io) => !!io.input.isTTY && typeof io.input.setRawMode === 'function';

const KEYS_HELP_ONE = 'Up/Down to move, Enter to choose, q to go back';
const KEYS_HELP_MANY = 'Up/Down to move, Space to toggle, a for all/none, Enter to confirm, q to cancel';

/**
 * @param {string} title @param {Option[]} options @param {boolean} multi @param {number} cursor @param {Set<string>} on
 * @returns {string[]}
 */
function frame(title, options, multi, cursor, on) {
  const lines = [...title.split('\n'), ''];
  options.forEach((o, i) => {
    const mark = multi ? (on.has(o.value) ? '[x] ' : '[ ] ') : '';
    lines.push(`${i === cursor ? '> ' : '  '}${mark}${o.label}${o.hint ? `  - ${o.hint}` : ''}`);
  });
  lines.push('', multi ? KEYS_HELP_MANY : KEYS_HELP_ONE);
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
    const max = (output.columns || 80) - 1;
    const lines = frame(title, options, multi, cursor, on).map((l) => (l.length > max ? l.slice(0, max - 3) + '...' : l));
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
    /** @param {string[] | null} result */
    const done = (result) => {
      input.off('keypress', onKey);
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
