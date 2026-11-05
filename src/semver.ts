// Minimal semver: MAJOR.MINOR.PATCH with optional leading "v" and optional -prerelease.
// Build metadata (+...) is ignored, as the spec says.

const RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
// Some addons number rebuilds 1.0.5, 1.0.5-b, 1.0.5-c ...: a single letter after the
// dash is a later build of the same version, not a prerelease (opt in with { letters: true }).
const LETTER_RE = /^v?(\d+)\.(\d+)\.(\d+)-([a-z])$/;
// Some addons number releases with a bare build number ("839") or two parts ("1.2"):
// with { loose: true } the missing parts count as 0, so 839 -> 839.0.0.
const LOOSE_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
  letter: string;
}
export interface ParseOptions {
  letters?: boolean;
  loose?: boolean;
}

export function parse(s: string, o: ParseOptions = {}): SemVer | null {
  const text = String(s).trim();
  if (o.letters) {
    const l = LETTER_RE.exec(text);
    if (l) return { major: +l[1], minor: +l[2], patch: +l[3], pre: [], letter: l[4] };
  }
  const m = RE.exec(text);
  if (!m) {
    const l = o.loose ? LOOSE_RE.exec(text) : null;
    return l ? { major: +l[1], minor: +(l[2] ?? 0), patch: +(l[3] ?? 0), pre: [], letter: '' } : null;
  }
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [], letter: '' };
}

export function valid(s: string, o?: ParseOptions): boolean {
  return parse(s, o) !== null;
}

/** Strip a leading "v". Returns null for invalid input. */
export function clean(s: string, o?: ParseOptions): string | null {
  const v = parse(s, o);
  if (!v) return null;
  return `${v.major}.${v.minor}.${v.patch}` + (v.letter ? `-${v.letter}` : v.pre.length ? `-${v.pre.join('.')}` : '');
}

/**
 * Compare two versions. Invalid versions sort below every valid one.
 */
export function compare(a: string, b: string, o?: ParseOptions): -1 | 0 | 1 {
  const x = parse(a, o), y = parse(b, o);
  if (!x && !y) return 0;
  if (!x) return -1;
  if (!y) return 1;
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (x.letter !== y.letter) return x.letter < y.letter ? -1 : 1; // "" (the original build) sorts first
  // A version without prerelease is greater than one with it.
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  const n = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < n; i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (+p !== +q) return +p < +q ? -1 : 1;
    } else if (pn !== qn) {
      return pn ? -1 : 1; // numeric identifiers sort lower
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

/** Highest valid version in the list, or null. */
export function max(list: string[], o?: ParseOptions): string | null {
  let best: string | null = null;
  for (const v of list) {
    if (!valid(v, o)) continue;
    if (best === null || compare(v, best, o) > 0) best = v;
  }
  return best;
}
