// @ts-check
// The user's own addon list, addons.json in the config folder. Hand-editable, so
// nothing here may throw on bad input: a broken file or entry becomes a message and
// the rest of the tool carries on without it.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './config.js';
import { BUILTIN, BUILTIN_IDS } from './addons.js';
import { RETIRED_ITEMS } from './catalog.js';
import { isSpokenFolder } from './extract.js';

export const ADDONS_FILE = 'addons.json';

/** `owner/name` from a repo address: owner/name, a github.com URL, with .git or extra path. Null if it isn't one. @param {string} text */
export function parseRepo(text) {
  const t = String(text ?? '').trim();
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(t) ?? /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(t);
  if (!m || /^\.+$/.test(m[1]) || /^\.+$/.test(m[2])) return null;
  return `${m[1]}/${m[2]}`;
}

/** A short id from a repo name: "Krelock/Node_Sight" -> "node-sight". @param {string} repo */
export const slug = (repo) => (repo.split('/')[1] ?? repo).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** A plain folder name: no path parts, nothing Windows rejects. @param {string} n */
const isFolderName = (n) => typeof n === 'string' && n.trim() === n && n !== '' && n !== '.' && n !== '..' && !/[\\/:*?"<>|]/.test(n);

/**
 * Check entries from addons.json. Bad ones are skipped with a message that names the entry and the rule.
 * @param {unknown} list
 * @returns {{ entries: import('./addons.js').AddonEntry[], problems: string[] }}
 */
export function validate(list) {
  const problems = [];
  /** @type {import('./addons.js').AddonEntry[]} */
  const entries = [];
  if (!Array.isArray(list)) return { entries, problems: [`${ADDONS_FILE}: expected a list of addons under "addons"`] };

  // Folders already owned by something else, lower case.
  const taken = new Map(BUILTIN.flatMap((a) => a.folders.map((f) => [f.toLowerCase(), { who: a.title, builtin: true }])));
  // Ids the tool uses itself, including the retired Spoken 2.x ones it cleans up after.
  const ids = new Set([...BUILTIN_IDS, ...RETIRED_ITEMS]);

  list.forEach((raw, i) => {
    const e = /** @type {Record<string, any>} */ (raw && typeof raw === 'object' ? raw : {});
    const label = `${ADDONS_FILE} entry ${i + 1}${typeof e.repo === 'string' ? ` (${e.repo})` : ''}`;
    /** @param {string} why */
    const skip = (why) => problems.push(`${label} skipped: ${why}`);

    const repo = typeof e.repo === 'string' ? parseRepo(e.repo) : null;
    if (!repo) return skip('"repo" must look like owner/name or a github.com address');
    const folders = Array.isArray(e.folders) ? e.folders : null;
    if (!folders?.length) return skip('"folders" must list the addon folder names to install, e.g. ["MyAddon"]');
    const badFolder = folders.find((f) => !isFolderName(f));
    if (badFolder !== undefined) return skip(`"${badFolder}" is not a plain folder name`);
    const blizz = folders.find((f) => /^blizzard_/i.test(f));
    if (blizz) return skip(`${blizz} belongs to the game and can never be managed`);
    const clash = folders.find((f) => isSpokenFolder(f) || taken.has(f.toLowerCase()));
    if (clash) {
      const owner = isSpokenFolder(clash) ? { who: 'Spoken', builtin: true } : taken.get(clash.toLowerCase());
      return skip(owner?.builtin && owner.who.toLowerCase() === clash.toLowerCase() ? `${clash} is already built into this tool` : `${clash} is already managed by ${owner?.who}`);
    }

    const id = typeof e.id === 'string' && e.id ? e.id : slug(repo);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return skip(`id "${id}" may only use lower-case letters, digits and dashes`);
    if (ids.has(id) || /^(quests|zones|books)-audio/.test(id)) return skip(`id "${id}" is already in use; give it a different "id"`);
    if (e.asset !== undefined) {
      try {
        new RegExp(String(e.asset), 'i');
      } catch (err) {
        return skip(`"asset" is not a valid pattern (${/** @type {Error} */ (err).message})`);
      }
    }

    ids.add(id);
    for (const f of folders) taken.set(f.toLowerCase(), { who: String(e.title ?? id) });
    entries.push({
      id, repo, folders: [...folders], title: typeof e.title === 'string' && e.title ? e.title : repo.split('/')[1],
      blurb: typeof e.blurb === 'string' && e.blurb ? e.blurb : repo,
      asset: e.asset === undefined ? undefined : String(e.asset), letterSuffix: !!e.letter_suffix, custom: true,
    });
  });
  return { entries, problems };
}

/** The parsed file, or a message why not. A missing file is an empty list. @param {string} configDir */
function readDoc(configDir) {
  const file = path.join(configDir, ADDONS_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return { file, addons: [] };
    return { file, error: `cannot read ${file}: ${/** @type {Error} */ (e).message}` };
  }
  try {
    const doc = JSON.parse(text);
    const addons = Array.isArray(doc) ? doc : doc?.addons ?? [];
    if (!Array.isArray(addons)) return { file, error: `${file}: "addons" must be a list of addons. Fix it, or delete the file to start fresh.` };
    return { file, addons };
  } catch (e) {
    return { file, error: `${file} is not valid JSON. Fix it, or delete it to start fresh.` };
  }
}

/** Load the user's addons. Never throws. @param {string} configDir */
export function loadCustom(configDir) {
  const doc = readDoc(configDir);
  if (doc.error) return { entries: [], problems: [doc.error] };
  return validate(doc.addons);
}

/**
 * Add one entry to the file, keeping everything already in it. Refuses to touch a file it can't read.
 * @param {string} configDir @param {{ id: string, repo: string, folders: string[], title?: string, blurb?: string, asset?: string, letter_suffix?: boolean }} entry
 */
export function addCustom(configDir, entry) {
  const doc = readDoc(configDir);
  if (doc.error) throw new Error(doc.error);
  writeJsonAtomic(doc.file, { addons: [...doc.addons, entry] });
}

/**
 * Whether a new entry would be accepted next to the ones already in the file. Returns why not, or null.
 * @param {string} configDir @param {{ id: string, repo: string, folders: string[], title?: string }} entry
 */
export function checkNew(configDir, entry) {
  const doc = readDoc(configDir);
  if (doc.error) return doc.error;
  const before = validate(doc.addons).entries.length;
  const { entries, problems } = validate([...doc.addons, entry]);
  const why = problems[problems.length - 1] ?? '';
  return entries.length > before ? null : why.replace(/^.*? skipped: /, '') || 'it was not accepted';
}

/** Drop the entry with this id (an explicit "id" or the one derived from the repo). @param {string} configDir @param {string} id */
export function removeCustom(configDir, id) {
  const doc = readDoc(configDir);
  if (doc.error) throw new Error(doc.error);
  const keep = doc.addons.filter((/** @type {any} */ e) => (typeof e?.id === 'string' && e.id ? e.id : slug(String(e?.repo ?? ''))) !== id);
  if (keep.length !== doc.addons.length) writeJsonAtomic(doc.file, { addons: keep });
}
