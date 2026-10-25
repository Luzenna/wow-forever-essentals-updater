// @ts-check
// Extracts a release zip into a staging dir and finds the addon folders in it,
// whatever the zip's layout (backslashes, wrapper dirs, double nesting, flat files).
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { tocOwner, readFolderToc } from './toc.js';

/**
 * @typedef {{ name: string, size: number, isDir: boolean, raw: import('yauzl').Entry }} ZipEntry
 */

/**
 * Normalise an entry name: backslashes to slashes, no leading "./".
 * Rejects anything that could escape the target dir (zip-slip).
 * @param {string} name @returns {string}
 */
export function normaliseEntryName(name) {
  const n = name.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').some((s) => s === '..')) {
    throw new Error(`unsafe path in zip: ${name}`);
  }
  return n;
}

/** @param {string} n */
const ignored = (n) => n.startsWith('__MACOSX/') || n.split('/').pop() === '.DS_Store';

/** @param {string} file @returns {Promise<import('yauzl').ZipFile>} */
const openZip = (file) =>
  new Promise((resolve, reject) =>
    // decodeStrings: false so yauzl doesn't reject backslash paths; we normalise them ourselves.
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true }, (err, zf) =>
      err ? reject(err) : resolve(/** @type {import('yauzl').ZipFile} */ (zf))));

/** @param {import('yauzl').Entry} e */
function entryName(e) {
  const raw = /** @type {Buffer} */ (/** @type {unknown} */ (e.fileName));
  return raw.toString(e.generalPurposeBitFlag & 0x800 ? 'utf8' : 'latin1');
}

/** Read the central directory. @param {import('yauzl').ZipFile} zf @returns {Promise<ZipEntry[]>} */
function readEntries(zf) {
  return new Promise((resolve, reject) => {
    /** @type {ZipEntry[]} */
    const out = [];
    zf.on('entry', (/** @type {import('yauzl').Entry} */ e) => {
      try {
        const name = normaliseEntryName(entryName(e));
        const mode = (e.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) throw new Error(`symlink in zip: ${name}`);
        if (!ignored(name) && name) out.push({ name, size: e.uncompressedSize, isDir: name.endsWith('/'), raw: e });
        zf.readEntry();
      } catch (err) {
        reject(err);
      }
    });
    zf.on('end', () => resolve(out));
    zf.on('error', reject);
    zf.readEntry();
  });
}

/** Total uncompressed size, for the disk-space check before extracting. @param {string} file */
export async function uncompressedSize(file) {
  const zf = await openZip(file);
  try {
    return (await readEntries(zf)).reduce((n, e) => n + e.size, 0);
  } finally {
    zf.close();
  }
}

/**
 * The addon folders a zip would install, read from its file list without unpacking:
 * a folder X is an addon when the zip holds X/X.toc (or a flavor-suffixed one), wrapper
 * folders allowed. A zip with .toc files at its root counts as one folder named after the .toc.
 * @param {string} file @returns {Promise<string[]>}
 */
export async function zipAddonFolders(file) {
  const zf = await openZip(file);
  try {
    const names = new Map(); // lower case -> first spelling
    for (const e of await readEntries(zf)) {
      if (e.isDir) continue;
      const parts = e.name.split('/');
      const owner = tocOwner(parts[parts.length - 1]);
      if (!owner) continue;
      const folder = parts.length === 1 ? owner : parts[parts.length - 2];
      if (folder.toLowerCase() === owner.toLowerCase() && !names.has(folder.toLowerCase())) names.set(folder.toLowerCase(), folder);
    }
    return [...names.values()];
  } finally {
    zf.close();
  }
}

/**
 * Extract every file of the zip under `dest`.
 * @param {string} file @param {string} dest @returns {Promise<{ files: number, bytes: number }>}
 */
export async function extractZip(file, dest) {
  const zf = await openZip(file);
  let files = 0, total = 0;
  try {
    const root = path.resolve(dest);
    for (const e of await readEntries(zf)) {
      const target = path.resolve(root, e.name);
      if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`unsafe path in zip: ${e.name}`);
      if (e.isDir) {
        fs.mkdirSync(target, { recursive: true });
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const rs = await new Promise((resolve, reject) =>
        zf.openReadStream(e.raw, (err, s) => (err ? reject(err) : resolve(/** @type {NodeJS.ReadableStream} */ (s)))));
      await pipeline(rs, fs.createWriteStream(target));
      files++;
      total += e.size;
    }
  } finally {
    zf.close();
  }
  return { files, bytes: total };
}

/** @param {string} dir */
const listDir = (dir) => fs.readdirSync(dir, { withFileTypes: true });

/** Whether `dir` holds a .toc that belongs to a folder of its own name. @param {string} dir */
const isAddonDir = (dir) =>
  listDir(dir).some((e) => e.isFile() && tocOwner(e.name)?.toLowerCase() === path.basename(dir).toLowerCase());

/**
 * Find the addon folders in an extracted tree. A folder is an addon when it holds
 * <Folder>.toc (or a flavor-suffixed one). Wrapper folders without a matching .toc
 * are descended into; "X/X/X.toc" double nesting resolves to the inner X. A zip
 * with .toc files at its root is wrapped into a folder named after the .toc.
 * @param {string} staging @returns {{ name: string, dir: string }[]}
 */
export function findAddonRoots(staging) {
  const atRoot = listDir(staging).filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.toc'));
  if (atRoot.length) {
    const owner = /** @type {string} */ (tocOwner(atRoot.map((e) => e.name).sort((a, b) => a.length - b.length)[0]));
    const wrapped = path.join(staging, `.wrap-${Date.now()}`, owner);
    fs.mkdirSync(wrapped, { recursive: true });
    for (const e of listDir(staging)) {
      if (!e.name.startsWith('.wrap-')) fs.renameSync(path.join(staging, e.name), path.join(wrapped, e.name));
    }
    return [{ name: owner, dir: wrapped }];
  }

  /** @type {{ name: string, dir: string }[]} */
  const roots = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const e of listDir(dir)) {
      if (!e.isDirectory()) continue;
      const sub = path.join(dir, e.name);
      if (isAddonDir(sub)) {
        // Prefer the innermost of X/X/... when the same name is nested.
        let inner = sub;
        for (;;) {
          const twin = listDir(inner).find((c) => c.isDirectory() && c.name.toLowerCase() === path.basename(inner).toLowerCase());
          if (!twin || !isAddonDir(path.join(inner, twin.name))) break;
          inner = path.join(inner, twin.name);
        }
        roots.push({ name: path.basename(inner), dir: inner });
      } else {
        walk(sub);
      }
    }
  };
  walk(staging);

  const seen = new Set();
  for (const r of roots) {
    const k = r.name.toLowerCase();
    if (seen.has(k)) throw new Error(`zip contains two addon folders named ${r.name}`);
    seen.add(k);
  }
  return roots;
}

/**
 * Only folders named Spoken* are ever written. The zips also carry
 * VoiceOverRedux / ZoneLore: code-less placeholders under the addons' old
 * names, only useful for carrying over settings from those old addons. We
 * never install them.
 * @param {string} name
 */
export function isSpokenFolder(name) {
  return /^spoken/i.test(name);
}

/**
 * Upstream's placeholders ("tombstones") for retired folder names: nothing but
 * .toc files, titled "... (now Spoken)" or marked X-Spoken-Tombstone. They never
 * load and are "safe to delete", so we don't install them. SpokenContributions
 * is also .toc-only but holds the player's contribution data, and isn't one.
 * @param {string} dir
 */
export function isPlaceholder(dir) {
  const files = [];
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else files.push(e.name);
    }
  };
  walk(dir);
  if (!files.length || !files.every((n) => n.toLowerCase().endsWith('.toc'))) return false;
  const t = readFolderToc(dir);
  return !!t && (/\(now [^)]+\)/i.test(t.fields['title'] ?? '') || t.fields['x-spoken-tombstone'] === '1');
}
