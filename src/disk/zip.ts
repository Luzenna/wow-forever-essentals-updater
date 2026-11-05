// Extracts a release zip into a staging dir and finds the addon folders in it,
// whatever the zip's layout (backslashes, wrapper dirs, double nesting, flat files).
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';
import { tocOwner } from './toc.ts';

export interface ZipEntry {
  name: string;
  size: number;
  isDir: boolean;
  raw: Entry;
}

/**
 * Normalise an entry name: backslashes to slashes, no leading "./".
 * Rejects anything that could escape the target dir (zip-slip).
 */
export function normaliseEntryName(name: string): string {
  const n = name.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').some((s) => s === '..')) {
    throw new Error(`unsafe path in zip: ${name}`);
  }
  return n;
}

const ignored = (n: string): boolean => n.startsWith('__MACOSX/') || n.split('/').pop() === '.DS_Store';

const openZip = (file: string): Promise<ZipFile> =>
  new Promise<ZipFile>((resolve, reject) =>
    // decodeStrings: false so yauzl doesn't reject backslash paths; we normalise them ourselves.
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true }, (err, zf) =>
      err ? reject(err) : resolve(zf as ZipFile)));

function entryName(e: Entry): string {
  const raw = e.fileName as unknown as Buffer;
  return raw.toString(e.generalPurposeBitFlag & 0x800 ? 'utf8' : 'latin1');
}

/** Read the central directory. */
function readEntries(zf: ZipFile): Promise<ZipEntry[]> {
  return new Promise((resolve, reject) => {
    const out: ZipEntry[] = [];
    zf.on('entry', (e: Entry) => {
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

/** Total uncompressed size, for the disk-space check before extracting. */
export async function uncompressedSize(file: string): Promise<number> {
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
 */
export async function zipAddonFolders(file: string): Promise<string[]> {
  const zf = await openZip(file);
  try {
    const names = new Map<string, string>(); // lower case -> first spelling
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
 */
export async function extractZip(file: string, dest: string): Promise<{ files: number; bytes: number }> {
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
      const rs = await new Promise<NodeJS.ReadableStream>((resolve, reject) =>
        zf.openReadStream(e.raw, (err, s) => (err ? reject(err) : resolve(s as NodeJS.ReadableStream))));
      await pipeline(rs, fs.createWriteStream(target));
      files++;
      total += e.size;
    }
  } finally {
    zf.close();
  }
  return { files, bytes: total };
}

const listDir = (dir: string): fs.Dirent[] => fs.readdirSync(dir, { withFileTypes: true });

/** Whether `dir` holds a .toc that belongs to a folder of its own name. */
const isAddonDir = (dir: string): boolean =>
  listDir(dir).some((e) => e.isFile() && tocOwner(e.name)?.toLowerCase() === path.basename(dir).toLowerCase());

/**
 * Find the addon folders in an extracted tree. A folder is an addon when it holds
 * <Folder>.toc (or a flavor-suffixed one). Wrapper folders without a matching .toc
 * are descended into; "X/X/X.toc" double nesting resolves to the inner X. A zip
 * with .toc files at its root is wrapped into a folder named after the .toc.
 */
export function findAddonRoots(staging: string): { name: string; dir: string }[] {
  const atRoot = listDir(staging).filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.toc'));
  if (atRoot.length) {
    const owner = tocOwner(atRoot.map((e) => e.name).sort((a, b) => a.length - b.length)[0]) as string;
    const wrapped = path.join(staging, `.wrap-${Date.now()}`, owner);
    fs.mkdirSync(wrapped, { recursive: true });
    for (const e of listDir(staging)) {
      if (!e.name.startsWith('.wrap-')) fs.renameSync(path.join(staging, e.name), path.join(wrapped, e.name));
    }
    return [{ name: owner, dir: wrapped }];
  }

  const roots: { name: string; dir: string }[] = [];
  const walk = (dir: string): void => {
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

  const seen = new Set<string>();
  for (const r of roots) {
    const k = r.name.toLowerCase();
    if (seen.has(k)) throw new Error(`zip contains two addon folders named ${r.name}`);
    seen.add(k);
  }
  return roots;
}
