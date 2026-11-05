// Everything that is specific to Spoken, in one place: its items (the addon and the voice packs),
// the retired 2.x names, which folders it owns, and the placeholder check.
import fs from 'node:fs';
import path from 'node:path';
import { SPOKEN } from './builtin.ts';
import { readFolderToc } from '../disk/toc.ts';
import type { Item, Kind, CatalogOptions } from './catalog.ts';

/** Language codes Spoken has voice packs for. */
export const LANGUAGES = ['enUS', 'frFR', 'deDE', 'esES', 'esMX', 'itIT', 'ptBR', 'ruRU', 'koKR', 'zhCN', 'zhTW'];

/** Item ids of the 2.x addons, which earlier versions of this tool installed. */
export const RETIRED_ITEMS = ['player', 'quests', 'zones', 'books'];
/**
 * Their folders, plus the 3.x module folders that were renamed (Spoken_Books -> Spoken_Readables,
 * Spoken_Zones -> Spoken_Places, ...). This is Spoken's own OLD_FOLDERS list in Core.lua minus the
 * non-Spoken-named placeholders; left beside the new ones, the old copies voice every line twice and
 * the game switches them off with a warning.
 */
export const RETIRED_FOLDERS = [
  'SpokenPlayer', 'SpokenQuests', 'SpokenZones', 'SpokenBooks',
  'Spoken_Books', 'Spoken_Zones', 'Spoken_Writings', 'Spoken_NPCs',
];

const SPOKEN_REPO = SPOKEN.repo;

const spokenPack = (id: string, title: string, kind: Kind, optional = false): Item => ({
  id, group: 'spoken', repo: SPOKEN_REPO, tagMode: 'prefix', tagPrefix: id, cacheKey: id, kind, title, optional,
  owns: isSpokenFolder, placeholders: true,
});

export function spokenItems(opts: CatalogOptions): Item[] {
  const lang = opts.language && opts.language !== 'enUS' ? opts.language : null;
  const exclude: string[] = [];
  // Zones and Books are the Places and Readables modules since 3.x was renamed; the old names stay in
  // the list so a zip from before the rename still honours the setting.
  if (!opts.includeZones) exclude.push('spoken_places', 'spoken_zones');
  if (!opts.includeBooks) exclude.push('spoken_readables', 'spoken_books');
  const items: Item[] = [{
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

/** Valid language codes look like enUS, frFR, zhTW. */
export function isLanguageCode(s: string) {
  return /^[a-z]{2}[A-Z]{2}$/.test(s);
}

/**
 * Only folders named Spoken* are ever written. The zips also carry
 * VoiceOverRedux / ZoneLore: code-less placeholders under the addons' old
 * names, only useful for carrying over settings from those old addons. We
 * never install them.
 */
export function isSpokenFolder(name: string) {
  return /^spoken/i.test(name);
}

/**
 * Upstream's placeholders ("tombstones") for retired folder names: nothing but
 * .toc files, titled "... (now Spoken)" or marked X-Spoken-Tombstone. They never
 * load and are "safe to delete", so we don't install them. SpokenContributions
 * is also .toc-only but holds the player's contribution data, and isn't one.
 */
export function isPlaceholder(dir: string) {
  const files: string[] = [];
  const walk = (d: string): void => {
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

/**
 * The ids (of state entries, pins ...) that belong to an addon group: Spoken is several items
 * (the addon, its voice packs in any language, and the retired 2.x items), every other addon is one.
 */
export const idsOfGroup = (group: string, ids: string[]) =>
  ids.filter((id) => (group === 'spoken' ? id === 'spoken' || /^(quests|zones|books)-audio/.test(id) || RETIRED_ITEMS.includes(id) : id === group));
