// @ts-check
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
import { isSpokenFolder } from './extract.js';
import { SPOKEN, BUILTIN, BUILTIN_IDS } from './addons.js';

/**
 * @typedef {'addon' | 'pack'} Kind
 * @typedef {object} Item
 * @property {string} id
 * @property {string} group         addon group id (see GROUPS); what the menu selects
 * @property {string} repo          GitHub "owner/name" the releases come from
 * @property {'prefix' | 'plain'} tagMode  "<tagPrefix>/<version>" tags, or the whole tag is the version
 * @property {string} [tagPrefix]   prefix mode only
 * @property {string} [assetPrefix] asset name stem ("NodeSight" -> NodeSight-1.4.1.zip); defaults to tagPrefix
 * @property {boolean} [letterSuffix] tags like 1.0.5-f are later builds of 1.0.5, not prereleases
 * @property {string} cacheKey      directory name in the download cache
 * @property {Kind} kind
 * @property {string} title
 * @property {boolean} optional     missing upstream means "skip with a notice"
 * @property {(folder: string) => boolean} owns  folders this item may write or remove; nothing else is ever touched
 * @property {string[]} [folders]   exact folder names, when known up front (lets a hand-installed copy be adopted)
 * @property {boolean} [placeholders] the zip carries empty placeholder folders that must not be installed
 * @property {RegExp} [assetPattern] picks the zip when a release has several
 * @property {string} [pin]         hold this exact version (set from the config's "pinned")
 * @property {string[]} [exclude]   folders in the zip not to install (lower case)
 * @property {{ items: string[], folders: string[] }} [replaces]  retired items/folders this item supersedes
 * @typedef {{ language: string, includeZones: boolean, includeBooks: boolean, selected?: string[], custom?: import('./addons.js').AddonEntry[], pinned?: Record<string, string> }} CatalogOptions
 * @typedef {{ id: string, title: string, blurb: string, repo: string, custom?: boolean }} Group
 */

/**
 * Addon groups in menu order: Spoken, the built-in addons, then the user's own.
 * @param {import('./addons.js').AddonEntry[]} [custom] @returns {Group[]}
 */
export function listGroups(custom = []) {
  return [SPOKEN, ...BUILTIN, ...custom].map((a) => ({ id: a.id, title: a.title, blurb: a.blurb, repo: a.repo, custom: 'custom' in a && !!a.custom }));
}
/** Ids of the groups that ship with the tool. */
export const ALL_GROUPS = BUILTIN_IDS;

/** Item ids of the 2.x addons, which earlier versions of this tool installed. */
export const RETIRED_ITEMS = ['player', 'quests', 'zones', 'books'];
/** Their folders (the same list Spoken's own Core.lua warns about, minus the non-Spoken-named placeholders). */
export const RETIRED_FOLDERS = ['SpokenPlayer', 'SpokenQuests', 'SpokenZones', 'SpokenBooks'];

const SPOKEN_REPO = SPOKEN.repo;

/** @param {string} id @param {string} title @param {Kind} kind @param {boolean} [optional] @returns {Item} */
const spokenPack = (id, title, kind, optional = false) => ({
  id, group: 'spoken', repo: SPOKEN_REPO, tagMode: 'prefix', tagPrefix: id, cacheKey: id, kind, title, optional,
  owns: isSpokenFolder, placeholders: true,
});

/**
 * An addon released on plain vX.Y.Z tags that owns a fixed set of folders.
 * @param {import('./addons.js').AddonEntry} a @returns {Item}
 */
const plainAddon = (a) => {
  const mine = new Set(a.folders.map((f) => f.toLowerCase()));
  return {
    id: a.id, group: a.id, repo: a.repo, tagMode: 'plain', assetPrefix: a.folders[0], letterSuffix: a.letterSuffix, cacheKey: a.id,
    kind: 'addon', title: a.title, optional: false, folders: a.folders, owns: (n) => mine.has(n.toLowerCase()),
    assetPattern: a.asset ? new RegExp(a.asset, 'i') : undefined,
  };
};

/**
 * Items to manage, in install order: each selected addon, with Spoken's voice packs after it.
 * @param {CatalogOptions} opts @returns {Item[]}
 */
export function buildCatalog(opts) {
  const plain = [...BUILTIN, ...(opts.custom ?? [])];
  const selected = new Set(opts.selected ?? [SPOKEN.id, ...plain.map((a) => a.id)]);
  /** @type {Item[]} */
  const items = [];
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

/** @param {CatalogOptions} opts @returns {Item[]} */
function spokenItems(opts) {
  const lang = opts.language && opts.language !== 'enUS' ? opts.language : null;
  const exclude = [];
  if (!opts.includeZones) exclude.push('spoken_zones');
  if (!opts.includeBooks) exclude.push('spoken_books');
  /** @type {Item[]} */
  const items = [{
    ...spokenPack('spoken', 'Spoken addon', 'addon'),
    exclude, replaces: { items: RETIRED_ITEMS, folders: RETIRED_FOLDERS },
  }];

  items.push(spokenPack('quests-audio', 'Spoken Quests Audio (All)', 'pack'));
  if (opts.includeZones) items.push(spokenPack('zones-audio', 'Spoken Zones Audio', 'pack'));
  if (opts.includeBooks) items.push(spokenPack('books-audio', 'Spoken Books Audio', 'pack'));

  // Language packs install alongside the English ones. Not every language exists
  // for every pack, so they are optional.
  if (lang) {
    items.push(spokenPack(`quests-audio-${lang}`, `Spoken Quests Audio (${lang})`, 'pack', true));
    if (opts.includeZones) items.push(spokenPack(`zones-audio-${lang}`, `Spoken Zones Audio (${lang})`, 'pack', true));
    if (opts.includeBooks) items.push(spokenPack(`books-audio-${lang}`, `Spoken Books Audio (${lang})`, 'pack', true));
  }
  return items;
}

/** Valid language codes look like enUS, frFR, zhTW. @param {string} s */
export function isLanguageCode(s) {
  return /^[a-z]{2}[A-Z]{2}$/.test(s);
}
