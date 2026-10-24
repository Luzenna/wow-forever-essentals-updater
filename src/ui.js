// @ts-check
// Look and feel: colours, symbols, the banner and small layout helpers. Everything
// degrades to plain text when output is redirected, NO_COLOR is set, or the console
// can't be trusted with Unicode, so logs and scripts keep working.
//
// The symbols are all in Windows' oldest console code page (437), so they draw in
// every console font, not only in Windows Terminal.

/** Colour and styling are on for a real terminal, off for pipes and NO_COLOR. FORCE_COLOR turns them on regardless. */
export function colorOn() {
  const e = process.env;
  if (e.NO_COLOR) return false;
  if (e.FORCE_COLOR && e.FORCE_COLOR !== '0') return true;
  return !!process.stdout.isTTY && e.TERM !== 'dumb';
}

/** Whether box-drawing and symbol characters are safe to print. */
export function unicodeOn() {
  const e = process.env;
  if (e.WFE_ASCII) return false;
  // Windows consoles (Windows Terminal and the classic one with Consolas/Cascadia) draw these; set WFE_ASCII=1 for a raster-font console.
  if (process.platform === 'win32') return true;
  const loc = e.LC_ALL || e.LC_CTYPE || e.LANG || '';
  return !loc || /utf-?8/i.test(loc); // unset (a launcher without a locale) is treated as UTF-8
}

/** @type {Record<string, [number, number]>} */
const CODES = {
  bold: [1, 22], dim: [2, 22], inverse: [7, 27],
  red: [31, 39], green: [32, 39], yellow: [33, 39], blue: [34, 39], magenta: [35, 39], cyan: [36, 39],
};

/** Wrap text in styles. @param {string | string[]} style @param {string} text */
export function paint(style, text) {
  if (!colorOn()) return text;
  const list = [].concat(/** @type {any} */ (style));
  const open = list.map((s) => `\x1b[${CODES[s][0]}m`).join('');
  const close = [...list].reverse().map((s) => `\x1b[${CODES[s][1]}m`).join('');
  return open + text + close;
}

/** @param {string} s */
export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
/** Printed width of a string, ignoring colour codes. @param {string} s */
export const vlen = (s) => [...stripAnsi(s)].length;
/** Pad to a printed width. @param {string} s @param {number} n */
export const pad = (s, n) => s + ' '.repeat(Math.max(0, n - vlen(s)));

/**
 * Cut a line to a printed width, keeping colour codes intact. A wrapped line would
 * throw off every in-place redraw, so anything that is redrawn goes through this.
 * @param {string} s @param {number} max
 */
export function truncate(s, max) {
  if (vlen(s) <= max) return s;
  const dots = unicodeOn() ? '…' : '...';
  let out = '', seen = 0;
  for (const part of s.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith('\x1b[')) {
      out += part;
      continue;
    }
    for (const ch of part) {
      if (seen >= max - dots.length) return out + dots + (colorOn() ? '\x1b[0m' : '');
      out += ch;
      seen++;
    }
  }
  return out;
}

/** The symbols in use right now. */
export function sym() {
  return unicodeOn()
    ? { ok: '√', warn: '!', fail: '×', on: '●', off: '○', pointer: '►', arrow: '→', bar: '█', barOff: '░', dot: '·', up: '↑', down: '↓', check: '●', uncheck: '○' }
    : { ok: 'OK', warn: '!', fail: 'x', on: '*', off: 'o', pointer: '>', arrow: '->', bar: '#', barOff: '-', dot: '-', up: 'Up', down: 'Down', check: '[x]', uncheck: '[ ]' };
}

/** Usable width of the terminal. */
export const columns = () => Math.max(40, (process.stdout.columns || 80) - 1);

/**
 * The title box at the top of the menu.
 * @param {string} left @param {string} [right]
 * @returns {string[]}
 */
export function banner(left, right = '') {
  const u = unicodeOn();
  const [tl, tr, bl, br, h, v] = u ? ['╔', '╗', '╚', '╝', '═', '║'] : ['+', '+', '+', '+', '-', '|'];
  const width = Math.min(columns(), 62);
  const inner = width - 2;
  const gap = Math.max(1, inner - 2 - vlen(left) - vlen(right));
  const edge = (/** @type {string} */ s) => paint('cyan', s);
  return [
    edge(tl + h.repeat(inner) + tr),
    edge(v) + ' ' + paint(['bold', 'cyan'], left) + ' '.repeat(gap) + paint('dim', right) + ' ' + edge(v),
    edge(bl + h.repeat(inner) + br),
  ];
}

/** A section heading with a rule after it. @param {string} text */
export function heading(text) {
  const line = unicodeOn() ? '─' : '-';
  const width = Math.min(columns(), 62);
  return paint('bold', text) + ' ' + paint('dim', line.repeat(Math.max(2, width - vlen(text) - 3)));
}

/** Clear the screen and home the cursor (real terminals only). @param {NodeJS.WriteStream} out */
export function clearScreen(out) {
  if (colorOn() && out.isTTY) out.write('\x1b[2J\x1b[H');
}
