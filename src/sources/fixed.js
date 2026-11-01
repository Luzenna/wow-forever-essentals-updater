// @ts-check
// An addon pinned to one exact file at a fixed URL. There is nothing to ask upstream, so
// this makes no request: the release is whatever the entry says, and the download is
// checked against the size and sha256 recorded with it.
//
// This is a stop-gap for an addon whose author has switched off third-party downloads on
// CurseForge (What's Training). It never moves on its own: a newer release means someone
// edits the entry in addons.js. Replace it with a real source once the author allows it.

/**
 * @typedef {object} FixedFile
 * @property {string} version  what the .toc says, e.g. "1.1.1"
 * @property {string} href     the file's URL
 * @property {number} size     bytes
 * @property {string} sha256   lowercase hex
 */

/** @param {import('../catalog.js').Item} item @returns {import('./source.js').Release} */
export function fixedRelease(item) {
  const f = item.url;
  if (!f) throw new Error(`${item.id} has no fixed file`);
  if (item.pin && item.pin.replace(/^v(?=\d)/i, '') !== f.version) {
    throw new Error(`${item.title} is only available as ${f.version}, so ${item.pin} cannot be pinned`);
  }
  const name = decodeURIComponent(new URL(f.href).pathname.split('/').pop() ?? '') || `${item.id}-${f.version}.zip`;
  return { version: f.version, tag: f.version, asset: { name, url: f.href, size: f.size, sha256: f.sha256.toLowerCase() }, notes: '', source: 'fixed URL' };
}
