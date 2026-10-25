// @ts-check
// Turn a GitHub release body into a few readable lines for "what's new".
// Bodies are markdown written for the web: headings, links, "by @user in <url>" tails.

/**
 * @param {string | null | undefined} body
 * @param {{ lines?: number, width?: number }} [o]
 * @returns {string[]}
 */
export function summarizeNotes(body, o = {}) {
  const max = o.lines ?? 5;
  const width = o.width ?? 76;
  const out = [];
  const text = String(body ?? '').replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (/^#{1,6}\s*(new contributors|contributors)\b/i.test(line)) break; // everything after is credits
    if (!line || /^#{1,6}\s/.test(line) || /^[-*_]{3,}$/.test(line) || /^\*{0,2}full changelog\*{0,2}\s*:/i.test(line)) continue;
    line = line
      .replace(/^[-*+]\s+/, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\s+by @[\w-]+(\s+in\s+\S+)?\s*$/i, '')
      .replace(/\s+in\s+https?:\/\/\S+\s*$/i, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[*_`]{1,3}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line) continue;
    out.push(line.length > width ? line.slice(0, width - 3).trimEnd() + '...' : line);
  }
  if (out.length <= max) return out;
  return [...out.slice(0, max), `...and ${out.length - max} more`];
}
