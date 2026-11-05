// The set of things we manage, grouped by addon. Only repos and tag conventions are
// known here; versions and assets are always discovered from the source at run time.
//
// Spoken: since 3.0.0 the player and the Quests/Zones/Books modules ship as one
// addon, "Spoken", in one zip on the spoken/ tag (folders Spoken, Spoken_Quests,
// Spoken_Zones, Spoken_Books, SpokenContributions). The 2.x addons (SpokenPlayer,
// SpokenQuests, SpokenZones, SpokenBooks, on the spoken/, quests/, zones/ and
// books/ tags) are retired; their folders must go when 3.x goes in, or both
// generations load and every line is voiced twice.
//
// Every other addon is one zip on plain vX.Y.Z tags that holds one folder.
import { SPOKEN, BUILTIN } from './builtin.ts';
import { spokenItems } from './spoken.ts';
import { UsageError } from '../errors.ts';
import type { AddonEntry } from './builtin.ts';
import type { FixedFile } from '../sources/fixed.ts';
import type { Options } from '../types.ts';
import type { Config } from '../config/config.ts';

export type Kind = 'addon' | 'pack';
export interface Item {
  id: string;
  /** addon group id (see GROUPS); what the menu selects */
  group: string;
  /** GitHub "owner/name" the releases come from (unset for a Wago addon) */
  repo?: string;
  /** Wago Addons slug the releases come from, instead of a GitHub repo */
  wago?: string;
  /** one exact file at a fixed URL, instead of a repo or Wago */
  url?: FixedFile;
  /** versions may be bare build numbers ("839"), compared as 839.0.0 */
  loose?: boolean;
  /** "<tagPrefix>/<version>" tags, or the whole tag is the version */
  tagMode: 'prefix' | 'plain';
  /** prefix mode only */
  tagPrefix?: string;
  /** asset name stem ("NodeSight" -> NodeSight-1.4.1.zip); defaults to tagPrefix */
  assetPrefix?: string;
  /** tags like 1.0.5-f are later builds of 1.0.5, not prereleases */
  letterSuffix?: boolean;
  /** directory name in the download cache */
  cacheKey: string;
  kind: Kind;
  title: string;
  /** missing upstream means "skip with a notice" */
  optional: boolean;
  /** folders this item may write or remove; nothing else is ever touched */
  owns: (folder: string) => boolean;
  /** exact folder names, when known up front (lets a hand-installed copy be adopted) */
  folders?: string[];
  /** the zip carries empty placeholder folders that must not be installed */
  placeholders?: boolean;
  /** picks the zip when a release has several */
  assetPattern?: RegExp;
  /** hold this exact version (set from the config's "pinned") */
  pin?: string;
  /** folders in the zip not to install (lower case) */
  exclude?: string[];
  /** retired items/folders this item supersedes */
  replaces?: { items: string[]; folders: string[] };
}
export interface CatalogOptions {
  language: string;
  includeZones: boolean;
  includeBooks: boolean;
  selected?: string[];
  custom?: AddonEntry[];
  pinned?: Record<string, string>;
}
export interface Group { id: string; title: string; blurb: string; repo: string; custom?: boolean }

/**
 * The ids plus everything they need to work (Baganator brings Syndicator), without duplicates.
 */
export function withRequired(ids: string[], entries: AddonEntry[]) {
  const byId = new Map(entries.map((a) => [a.id, a]));
  const out = new Set(ids);
  const todo = [...out];
  for (let id = todo.pop(); id !== undefined; id = todo.pop()) {
    for (const r of byId.get(id)?.requires ?? []) {
      if (out.has(r)) continue;
      out.add(r);
      todo.push(r);
    }
  }
  return [...out];
}

/**
 * Addon groups in menu order: Spoken, the built-in addons, then the user's own.
 */
export function listGroups(custom: AddonEntry[] = []): Group[] {
  return [SPOKEN, ...BUILTIN, ...custom].map((a) => ({ id: a.id, title: a.title, blurb: a.blurb, repo: a.repo ?? '', custom: 'custom' in a && !!a.custom }));
}

/**
 * An addon released on plain vX.Y.Z tags that owns a fixed set of folders.
 */
const plainAddon = (a: AddonEntry): Item => {
  const mine = new Set(a.folders.map((f) => f.toLowerCase()));
  return {
    id: a.id, group: a.id, repo: a.repo, wago: a.wago, url: a.url, loose: !!a.wago, tagMode: 'plain', assetPrefix: a.folders[0], letterSuffix: a.letterSuffix, cacheKey: a.id,
    kind: 'addon', title: a.title, optional: false, folders: a.folders, owns: (n) => mine.has(n.toLowerCase()),
    assetPattern: a.asset ? new RegExp(a.asset, 'i') : undefined,
  };
};

/**
 * Items to manage, in install order: each selected addon, with Spoken's voice packs after it.
 */
export function buildCatalog(opts: CatalogOptions): Item[] {
  const plain = [...BUILTIN, ...(opts.custom ?? [])];
  const selected = new Set(withRequired(opts.selected ?? [SPOKEN.id, ...plain.map((a) => a.id)], plain));
  const items: Item[] = [];
  if (selected.has(SPOKEN.id)) {
    for (const it of spokenItems(opts)) {
      if (opts.pinned?.[it.id]) it.pin = opts.pinned[it.id];
      items.push(it);
    }
  }
  for (const a of plain) {
    if (!selected.has(a.id)) continue;
    const item = plainAddon(a);
    if (opts.pinned?.[a.id]) item.pin = opts.pinned[a.id];
    items.push(item);
  }
  return items;
}

export function catalogFor(opts: Options, cfg: Config, custom: AddonEntry[] = []) {
  // --only can name any item, selected or not.
  const items = buildCatalog({
    language: opts.lang ?? cfg.language, includeZones: cfg.include_zones, includeBooks: cfg.include_books,
    selected: opts.only?.length ? undefined : cfg.selected, custom, pinned: cfg.pinned,
  });
  if (opts.only?.length) {
    const unknown = opts.only.filter((id) => !items.some((i) => i.id === id));
    if (unknown.length) {
      throw new UsageError(`unknown item(s): ${unknown.join(', ')}. Known: ${items.map((i) => i.id).join(', ')}`);
    }
  }
  return items;
}
