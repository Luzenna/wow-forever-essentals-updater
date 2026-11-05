// Case-insensitive path lookup. Linux (and SD cards formatted ext4) are case
// sensitive, but Wine is not, so "interface/addons" is as valid as "Interface/AddOns".
// We must reuse whatever already exists instead of creating a second copy.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Name of the child of `dir` matching `name` case-insensitively, or null.
 * An exact match wins; otherwise the first match in sorted order.
 */
export function findChild(dir: string, name: string, opts: { dirsOnly?: boolean } = {}): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const want = name.toLowerCase();
  const hits = entries
    .filter((e) => e.name.toLowerCase() === want && (!opts.dirsOnly || e.isDirectory() || e.isSymbolicLink()))
    .map((e) => e.name)
    .sort();
  if (!hits.length) return null;
  return hits.includes(name) ? name : hits[0];
}

/**
 * Resolve `parts` under `base`, matching each existing segment case-insensitively.
 * Segments that don't exist keep the canonical spelling given in `parts`.
 */
export function resolveFold(base: string, ...parts: string[]): { path: string; exists: boolean } {
  let cur = base;
  let exists = fs.existsSync(base);
  for (const p of parts.flatMap((s) => s.split(/[\\/]+/)).filter(Boolean)) {
    const hit = exists ? findChild(cur, p) : null;
    if (hit === null) exists = false;
    cur = path.join(cur, hit ?? p);
  }
  return { path: cur, exists };
}
