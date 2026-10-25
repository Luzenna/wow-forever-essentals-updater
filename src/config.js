// @ts-check
// Config and state files. Windows: %APPDATA%\wow-forever-essentals-updater (cache
// under %LOCALAPPDATA%). Linux: XDG dirs (~/.config, ~/.cache).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_IDS } from './addons.js';

export const APP = 'wow-forever-essentals-updater';
/** This tool's earlier name; its config and state are carried over once. */
export const LEGACY_APP = 'spoken-updater';

/**
 * @typedef {object} Config
 * @property {string} addons_path     overrides detection when set
 * @property {string} client_folder   Forever client folder under the WoW root
 * @property {string} language        enUS, or e.g. frFR to add that language's packs
 * @property {boolean} include_zones
 * @property {boolean} include_books
 * @property {string} github_token
 * @property {boolean} keep_downloads keep zips in the cache after a successful install
 * @property {string[]} selected      addon group ids to install and update (built-in ids, plus ids from addons.json)
 * @property {Record<string, string>} pinned  item id -> version to hold the addon at
 */

/** @type {Config} */
export const DEFAULT_CONFIG = {
  addons_path: '',
  client_folder: '_forever_',
  language: 'enUS',
  include_zones: true,
  include_books: true,
  github_token: '',
  keep_downloads: false,
  selected: BUILTIN_IDS,
  pinned: {},
};

/**
 * @typedef {{ files: number, bytes: number, tocVersion: string | null }} FolderState
 * @typedef {object} ItemState
 * @property {string} tag         release tag installed, e.g. "quests-audio/v2.2.1"
 * @property {string} version     release version installed
 * @property {string} asset
 * @property {string | null} sha256
 * @property {string[]} [exclude]  folders left out at install (zones/books switched off)
 * @property {string} installedAt
 * @property {Record<string, FolderState>} folders
 * @typedef {{ schema: 1, installs: Record<string, Record<string, ItemState>> }} State
 */

/** @param {NodeJS.ProcessEnv} [env] @param {string} [app] */
export function appDirs(env = process.env, app = APP) {
  const home = env.WFE_UPDATER_HOME || (app === APP ? env.SPOKEN_UPDATER_HOME : undefined);
  if (home) return { config: home, cache: path.join(home, 'cache') };
  if (process.platform === 'win32') {
    const roaming = env.APPDATA ?? path.join(os.homedir(), 'AppData/Roaming');
    const local = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local');
    return { config: path.join(roaming, app), cache: path.join(local, app, 'cache') };
  }
  const cfg = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const cache = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return { config: path.join(cfg, app), cache: path.join(cache, app) };
}

/**
 * Carry config.json and state.json over from spoken-updater's folder the first time
 * this tool runs (copied, never moved, so the old install keeps working). Does nothing
 * once config.json or state.json exists here. Returns true when something was copied.
 * @param {string} dir  the new config dir @param {NodeJS.ProcessEnv} [env]
 */
export function migrateLegacy(dir, env = process.env) {
  if (env.WFE_UPDATER_HOME || env.SPOKEN_UPDATER_HOME) return false; // an explicit home is never "legacy"
  if (['config.json', 'state.json'].some((f) => fs.existsSync(path.join(dir, f)))) return false;
  const old = appDirs(env, LEGACY_APP).config;
  let copied = false;
  for (const f of ['config.json', 'state.json']) {
    const src = path.join(old, f);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, path.join(dir, f));
    copied = true;
  }
  return copied;
}

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    if (e instanceof SyntaxError) throw new Error(`${file} is not valid JSON. Fix it, or delete it to start fresh.`);
    throw new Error(`cannot read ${file}: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * Write JSON atomically (temp file + rename). Does nothing when the content is
 * unchanged, so a no-op run leaves every file untouched. Returns true if written.
 * @param {string} file @param {unknown} data
 */
export function writeJsonAtomic(file, data) {
  const text = JSON.stringify(data, null, 2) + '\n';
  try {
    if (fs.readFileSync(file, 'utf8') === text) return false;
  } catch { /* missing */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return true;
}

/** @param {string} dir @returns {Config} */
export function loadConfig(dir) {
  const raw = readJson(path.join(dir, 'config.json')) ?? {};
  const cfg = { ...DEFAULT_CONFIG, ...raw };
  // Never share the default array. Ids are kept even when unknown here: custom addons come from addons.json.
  cfg.selected = (Array.isArray(cfg.selected) ? cfg.selected : BUILTIN_IDS).filter((g) => typeof g === 'string');
  cfg.pinned = cfg.pinned && typeof cfg.pinned === 'object' && !Array.isArray(cfg.pinned) ? { ...cfg.pinned } : {};
  return cfg;
}

/** @param {string} dir @param {Config} cfg */
export function saveConfig(dir, cfg) {
  return writeJsonAtomic(path.join(dir, 'config.json'), cfg);
}

/** @param {string} dir @returns {State} */
export function loadState(dir) {
  const raw = readJson(path.join(dir, 'state.json'));
  return raw?.schema === 1 ? raw : { schema: 1, installs: {} };
}

/** @param {string} dir @param {State} state */
export function saveState(dir, state) {
  return writeJsonAtomic(path.join(dir, 'state.json'), state);
}

/** State is keyed per AddOns folder so several WoW installs are tracked separately. @param {string} addons */
export function stateKey(addons) {
  const p = path.resolve(addons);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** Token lookup order: WFE_GITHUB_TOKEN, SPOKEN_GITHUB_TOKEN, GITHUB_TOKEN, config. @param {Config} cfg @param {NodeJS.ProcessEnv} [env] */
export function githubToken(cfg, env = process.env) {
  return env.WFE_GITHUB_TOKEN || env.SPOKEN_GITHUB_TOKEN || env.GITHUB_TOKEN || cfg.github_token || null;
}
