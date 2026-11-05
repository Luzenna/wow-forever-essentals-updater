// Work out what each item needs: compare what is on disk with the latest release.
import fs from 'node:fs';
import path from 'node:path';
import * as semver from '../semver.ts';
import { loadConfig } from '../config/config.ts';
import { loadState, stateKey } from '../config/state.ts';
import { loadCustom } from '../catalog/custom.ts';
import { catalogFor } from '../catalog/catalog.ts';
import { findChild } from '../disk/fold.ts';
import { tocFiles, readFolderToc } from '../disk/toc.ts';
import { treeStats } from '../disk/tree.ts';
import { devCopyReason } from '../disk/platform.ts';
import { resolveAddons } from './addons-dir.ts';
import type { Item } from '../catalog/catalog.ts';
import type { Release } from '../sources/source.ts';
import type { ItemState } from '../config/state.ts';
import type { Options, Deps } from '../types.ts';

export type Status = 'current' | 'outdated' | 'not-installed' | 'missing' | 'broken' | 'unavailable' | 'error' | 'dev';
export interface Plan {
  item: Item;
  release: Release | null;
  status: Status;
  installed: string | null;
  reason: string;
  /** folders on disk that belong to the item */
  folders: string[];
  diskBytes: number;
  /** will be (re)installed */
  act: boolean;
}

/**
 * Folder names an item had before this tool ever installed it (e.g. installed by
 * hand or by another manager), guessed from the asset name: "SpokenPlayer-2.3.2.zip"
 * -> SpokenPlayer; the "SpokenQuestsAudioAll" bundle -> SpokenQuestsAudio<Faction>.
 * Items that know their folder names up front ("NodeSight") just look those up.
 */
function adoptFolders(addons: string, item: Item, rel: Release): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(addons, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  } catch {
    return [];
  }
  if (item.folders) {
    const want = item.folders.map((f) => f.toLowerCase());
    return names.filter((n) => want.includes(n.toLowerCase()));
  }
  const base = rel.asset.name.replace(/-v?\d+\.\d+\.\d+.*\.zip$/i, '').replace(/\.zip$/i, '');
  const exact = names.filter((n) => n.toLowerCase() === base.toLowerCase());
  if (exact.length) return exact;
  if (/All$/.test(base)) {
    const stem = base.slice(0, -3).toLowerCase();
    return names.filter((n) => n.toLowerCase().startsWith(stem) && /^[A-Z]/.test(n.slice(stem.length)));
  }
  return [];
}

/**
 * Compare what's on disk with the latest release. The .toc wins over the state
 * file; the state file supplies folder names and the size baseline.
 */
export function inspect(item: Item, rel: Release | null, addons: string, st: ItemState | undefined, flags: { overwriteDev?: boolean } = {}): Plan {
  const plan: Plan = { item, release: rel, status: 'current', installed: null, reason: '', folders: [], diskBytes: 0, act: false };
  if (!rel) {
    return { ...plan, status: 'unavailable', reason: item.optional ? 'not published for this language' : 'no release found' };
  }
  const o = { letters: !!item.letterSuffix, loose: !!item.loose };
  // Older state files may list placeholder folders the item doesn't own; they're not ours to check.
  const recorded = (st ? Object.keys(st.folders) : adoptFolders(addons, item, rel)).filter(item.owns);
  if (!recorded.length) return { ...plan, status: 'not-installed', reason: 'not installed', act: true };

  const seen: { name: string; version: string | null; recordedVersion: string | null }[] = [];
  for (const name of recorded) {
    const actual = findChild(addons, name, { dirsOnly: true });
    if (!actual) return { ...plan, status: 'missing', reason: `folder ${name} is missing`, act: true };
    const dir = path.join(addons, actual);
    const dev = flags.overwriteDev ? null : devCopyReason(addons, actual);
    if (dev) return { ...plan, status: 'dev', reason: `${actual} ${dev}, so it is left alone`, act: false };
    plan.folders.push(actual);
    if (!tocFiles(dir).length) return { ...plan, status: 'broken', reason: `${name} has no .toc`, act: true };
    const s = treeStats(dir);
    plan.diskBytes += s.bytes;
    const rec = st?.folders[name];
    if (rec && (s.files < rec.files * 0.9 || s.files > rec.files * 1.1 || s.bytes < rec.bytes * 0.9 || s.bytes > rec.bytes * 1.1)) {
      return { ...plan, status: 'broken', reason: `${name} looks incomplete (${s.files}/${rec.files} files)`, act: true };
    }
    seen.push({ name, version: readFolderToc(dir)?.version ?? null, recordedVersion: rec?.tocVersion ?? null });
  }

  // The item's version comes from its main folders: those whose .toc carried the
  // release version at install time (this skips tombstones and helper folders that
  // have their own numbering). Without such a record, every versioned folder counts.
  let primary = st ? seen.filter((f) => f.recordedVersion === st.version) : [];
  if (!primary.length) primary = seen.filter((f) => f.version);
  const versions = primary.map((f) => f.version).filter((v): v is string => v !== null);
  const installed = versions.length ? versions.reduce((a, b) => (semver.compare(a, b, o) <= 0 ? a : b)) : st?.version ?? null;
  plan.installed = installed;

  const leftovers = (item.replaces?.folders ?? []).filter((n) => findChild(addons, n, { dirsOnly: true }));
  const exclusionChanged = !!st && [...(st.exclude ?? [])].sort().join() !== [...(item.exclude ?? [])].sort().join();
  // A .toc often can't tell 1.0.5 from its 1.0.5-f rebuild, so a pin is also checked against the tag we installed from.
  if (item.pin && st && st.tag !== rel.tag) return { ...plan, status: 'outdated', reason: `${st.version} -> ${rel.version} (pinned)`, act: true };
  if (installed && semver.compare(installed, rel.version, o) === 0) {
    if (leftovers.length) return { ...plan, status: 'outdated', reason: `old folders to remove: ${leftovers.join(', ')}`, act: true };
    if (exclusionChanged) return { ...plan, status: 'outdated', reason: 'zones/books setting changed', act: true };
    return plan;
  }
  // Never downgrade: a newer build (from Wago, or a dev copy) is left alone. A pinned version is the exception: it is the target.
  if (!item.pin && installed && semver.compare(installed, rel.version, o) > 0) return { ...plan, reason: `newer than the latest release (${rel.version})` };
  // Upstream sometimes ships a .toc whose Version differs from the tag. If the
  // folders still hold exactly what we installed from this tag, it is current.
  if (st && st.tag === rel.tag && primary.length && primary.every((f) => f.version === f.recordedVersion)) {
    return { ...plan, installed: st.version };
  }
  return { ...plan, status: 'outdated', reason: `${installed ?? 'unknown'} -> ${rel.version}${item.pin ? ' (pinned)' : ''}`, act: true };
}

/**
 * Build the plan for every item.
 */
export async function makePlan(opts: Options, deps: Deps) {
  const cfg = loadConfig(deps.configDir);
  const { entries: custom, problems } = loadCustom(deps.configDir);
  // With --only, other items are neither queried nor reported: an unrelated repo being down must not fail the run.
  const items = catalogFor(opts, cfg, custom).filter((i) => !opts.only?.length || opts.only.includes(i.id));
  const addons = await resolveAddons(opts, deps, cfg);
  const state = loadState(deps.configDir);
  const mine = state.installs[stateKey(addons)] ?? {};
  // One request per repo is shared between its items, and the repos are asked at the same time.
  const plans: Plan[] = await Promise.all(items.map(async (item) => {
    try {
      const rel = await deps.source.latest(item);
      const p = inspect(item, rel, addons, mine[item.id], { overwriteDev: opts.overwriteDev });
      if (opts.only?.length) p.act = opts.only.includes(item.id) && !!rel && p.status !== 'dev';
      return p;
    } catch (e) {
      // One broken release (e.g. an unexpected asset layout) must not stop the others.
      return { item, release: null, status: 'error', installed: null, reason: (e as Error).message, folders: [], diskBytes: 0, act: false } as Plan;
    }
  }));
  return { cfg, addons, state, plans, custom, problems };
}
