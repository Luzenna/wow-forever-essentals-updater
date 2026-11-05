// Download, unpack and swap one item into the AddOns folder.
import fs from 'node:fs';
import path from 'node:path';
import * as log from '../ui/log.ts';
import { stateKey, saveState } from '../config/state.ts';
import { summarizeNotes } from '../sources/notes.ts';
import { findChild } from '../disk/fold.ts';
import { folderSupports, FOREVER_INTERFACE, readFolderToc } from '../disk/toc.ts';
import { cachePath, download, remainingBytes } from '../net/download.ts';
import { extractZip, findAddonRoots, uncompressedSize } from '../disk/zip.ts';
import { isPlaceholder } from '../catalog/spoken.ts';
import { treeStats } from '../disk/tree.ts';
import { swapIn, workDirFor } from '../disk/swap.ts';
import { createProgress } from '../ui/progress.ts';
import { freeBytes, deviceOf, devCopyReason } from '../disk/platform.ts';
import { colorOn } from '../ui/term.ts';
import type { Plan } from './plan.ts';
import type { Release } from '../sources/source.ts';
import type { Deps, Options } from '../types.ts';
import type { Config } from '../config/config.ts';
import type { State, FolderState } from '../config/state.ts';

const MARGIN = 200e6; // keep 200 MB free on every filesystem we write to
const UNPACK_FACTOR = 1.05; // audio barely compresses; exact size is checked again per zip

/**
 * Zips are deleted after each install unless keep_downloads is set, so the cache
 * only needs room for the largest one; AddOns needs room for everything unpacked.
 */
export function checkSpace(plans: Plan[], addons: string, cacheDir: string, keepDownloads: boolean) {
  const need = new Map<number, { bytes: number; where: string }>(); // device -> { bytes, where }
  const add = (p: string, n: number) => {
    const dev = deviceOf(p);
    const cur = need.get(dev) ?? { bytes: 0, where: p };
    cur.bytes += n;
    need.set(dev, cur);
  };
  let cache = 0;
  for (const p of plans.filter((x) => x.act && x.release)) {
    const rel = p.release as Release;
    const left = remainingBytes(cachePath(cacheDir, p.item, rel), rel.asset.size);
    cache = keepDownloads ? cache + left : Math.max(cache, left);
    add(addons, rel.asset.size * UNPACK_FACTOR);
  }
  add(cacheDir, cache);
  for (const { bytes, where } of need.values()) {
    const free = freeBytes(where);
    if (bytes + MARGIN > free) {
      throw new Error(`not enough disk space on the drive holding ${where}: need ${log.bytes(bytes + MARGIN)}, ${log.bytes(free)} free`);
    }
  }
}

/**
 * Download, unpack and swap one item. Returns bytes downloaded.
 */
export async function installItem(plan: Plan, addons: string, deps: Deps, cfg: Config, state: State, opts: Options): Promise<number> {
  const rel = plan.release as Release;
  const L = log.scoped(plan.item.id, plan.item.title);
  L.head(`${plan.reason}`);
  if (colorOn() && plan.status === 'outdated' && plan.installed) {
    const news = summarizeNotes(rel.notes);
    if (news.length) {
      L.info("What's new:");
      for (const n of news) L.info(`  ${n}`);
    }
  }
  const zip = cachePath(deps.cacheDir, plan.item, rel);
  const left = remainingBytes(zip, rel.asset.size);
  L.info(`${colorOn() ? '' : plan.reason + ': '}${left ? `downloading ${log.bytes(left)}` : 'using cached download'} (${rel.asset.name})`);
  const bar = createProgress(plan.item.id, rel.asset.size, { tty: deps.tty });
  const got = await download(rel.asset, zip, {
    fetchImpl: deps.fetchImpl,
    onProgress: left ? (n) => bar.update(n) : undefined,
    onRetry: (e, n) => L.warn(`download problem (${(e as Error).message}), retry ${n}`),
  });
  if (left && !got.cached) bar.finish(rel.asset.size);
  L.debug(`verified ${rel.asset.sha256 ? 'sha256 ' + rel.asset.sha256.slice(0, 12) : 'size only (no digest published)'}`);

  const workDir = workDirFor(addons);
  const unpacked = await uncompressedSize(zip);
  if (unpacked + MARGIN > freeBytes(addons)) throw new Error(`not enough disk space to unpack ${log.bytes(unpacked)} into ${addons}`);
  const staging = path.join(workDir, `staging-${process.pid}-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    L.info(`unpacking ${log.bytes(unpacked)}`);
    await extractZip(zip, staging);
    const roots = findAddonRoots(staging);
    const excluded = new Set(plan.item.exclude ?? []);
    const keep = roots.filter((r) => {
      let why: string | null = null;
      if (!plan.item.owns(r.name)) why = `not a folder of ${plan.item.id}`;
      else if (plan.item.placeholders && isPlaceholder(r.dir)) why = 'an empty placeholder for a retired folder';
      else if (excluded.has(r.name.toLowerCase())) why = 'switched off in the config';
      if (why) L.debug(`not installing ${r.name} (${why})`);
      return !why;
    });
    if (!keep.length) throw new Error(`the zip contains no ${plan.item.title} addon folders`);
    for (const r of keep) {
      if (!folderSupports(r.dir, FOREVER_INTERFACE)) {
        L.warn(`${r.name}: no .toc lists Interface ${FOREVER_INTERFACE}; the Forever client may mark it incompatible`);
      }
    }
    const folders: Record<string, FolderState> = {};
    for (const r of keep) folders[r.name] = { ...treeStats(r.dir), tocVersion: readFolderToc(r.dir)?.version ?? null };

    // Remove, in the same transaction: folders this item installed before that the
    // new release no longer has (or that are now switched off), and the folders of
    // the retired addons this item replaces. Only folders this item owns, ever.
    const key = stateKey(addons);
    const mine = state.installs[key] ?? {};
    const keepNames = new Set(keep.map((r) => r.name.toLowerCase()));
    const remove = [...new Set([
      ...Object.keys(mine[plan.item.id]?.folders ?? {}),
      ...(plan.item.replaces?.items ?? []).flatMap((id) => Object.keys(mine[id]?.folders ?? {})),
      ...(plan.item.replaces?.folders ?? []),
    ])].filter((n) => plan.item.owns(n) &&!keepNames.has(n.toLowerCase()) && findChild(addons, n, { dirsOnly: true }));
    for (const n of remove) L.info(`removing old folder ${n}`);
    if (!opts.overwriteDev) {
      for (const n of [...keep.map((r) => r.name), ...remove]) {
        const here = findChild(addons, n, { dirsOnly: true });
        const dev = here && devCopyReason(addons, here);
        if (dev) throw new Error(`${here} ${dev}, so it was left alone (pass --overwrite-dev to replace it)`);
      }
    }

    swapIn({ addons, roots: keep, remove, workDir });
    for (const id of plan.item.replaces?.items ?? []) delete mine[id];

    const tocVersion = Object.values(folders).find((f) => f.tocVersion === rel.version)?.tocVersion;
    if (!tocVersion) L.warn(`no .toc reports version ${rel.version}; tracking by release tag ${rel.tag}`);
    state.installs[key] = mine;
    state.installs[key][plan.item.id] = {
      tag: rel.tag, version: rel.version, asset: rel.asset.name, sha256: rel.asset.sha256, exclude: plan.item.exclude ?? [],
      installedAt: new Date().toISOString(), folders,
    };
    saveState(deps.configDir, state);
    L.ok(`installed ${rel.version}: ${keep.map((r) => r.name).join(', ')}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    try {
      fs.rmdirSync(workDir); // only succeeds when empty
    } catch { /* still has other content */ }
  }
  if (!cfg.keep_downloads) {
    fs.rmSync(path.dirname(zip), { recursive: true, force: true });
    // Drop the now-empty <version> and <prefix> dirs too.
    for (let d = path.dirname(path.dirname(zip)), i = 0; i < 2; i++, d = path.dirname(d)) {
      try {
        fs.rmdirSync(d);
      } catch {
        break;
      }
    }
  }
  return got.downloaded;
}
