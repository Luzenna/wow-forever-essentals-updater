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

const CODES: Record<string, [number, number]> = {
  bold: [1, 22], dim: [2, 22], inverse: [7, 27],
  red: [31, 39], green: [32, 39], yellow: [33, 39], blue: [34, 39], magenta: [35, 39], cyan: [36, 39],
};

/** Wrap text in styles. */
export function paint(style: string | string[], text: string): string {
  if (!colorOn()) return text;
  const list = ([] as string[]).concat(style);
  const open = list.map((s) => `\x1b[${CODES[s][0]}m`).join('');
  const close = [...list].reverse().map((s) => `\x1b[${CODES[s][1]}m`).join('');
  return open + text + close;
}

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
/** Printed width of a string, ignoring colour codes. */
export const vlen = (s: string) => [...stripAnsi(s)].length;
/** Pad to a printed width. */
export const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - vlen(s)));

/**
 * Cut a line to a printed width, keeping colour codes intact. A wrapped line would
 * throw off every in-place redraw, so anything that is redrawn goes through this.
 */
export function truncate(s: string, max: number): string {
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
 */
export function banner(left: string, right = ''): string[] {
  const u = unicodeOn();
  const [tl, tr, bl, br, h, v] = u ? ['╔', '╗', '╚', '╝', '═', '║'] : ['+', '+', '+', '+', '-', '|'];
  const width = Math.min(columns(), 62);
  const inner = width - 2;
  const gap = Math.max(1, inner - 2 - vlen(left) - vlen(right));
  const edge = (s: string) => paint('cyan', s);
  return [
    edge(tl + h.repeat(inner) + tr),
    edge(v) + ' ' + paint(['bold', 'cyan'], left) + ' '.repeat(gap) + paint('dim', right) + ' ' + edge(v),
    edge(bl + h.repeat(inner) + br),
  ];
}

/** A section heading with a rule after it. */
export function heading(text: string): string {
  const line = unicodeOn() ? '─' : '-';
  const width = Math.min(columns(), 62);
  return paint('bold', text) + ' ' + paint('dim', line.repeat(Math.max(2, width - vlen(text) - 3)));
}

/** Clear the screen and home the cursor (real terminals only). */
export function clearScreen(out: NodeJS.WriteStream) {
  if (colorOn() && out.isTTY) out.write('\x1b[2J\x1b[H');
}
