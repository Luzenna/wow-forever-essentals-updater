// config.json: the user's settings.
import path from 'node:path';
import { DEFAULT_SELECTED } from '../catalog/builtin.ts';
import { readJson, writeJsonAtomic } from './paths.ts';

export interface Config {
  /** overrides detection when set */
  addons_path: string;
  /** Forever client folder under the WoW root */
  client_folder: string;
  /** enUS, or e.g. frFR to add that language's packs */
  language: string;
  include_zones: boolean;
  include_books: boolean;
  github_token: string;
  /** keep zips in the cache after a successful install */
  keep_downloads: boolean;
  /** addon group ids to install and update (built-in ids, plus ids from addons.json) */
  selected: string[];
  /** item id -> version to hold the addon at */
  pinned: Record<string, string>;
}

export const DEFAULT_CONFIG: Config = {
  addons_path: '',
  client_folder: '_forever_',
  language: 'enUS',
  include_zones: true,
  include_books: true,
  github_token: '',
  keep_downloads: false,
  selected: DEFAULT_SELECTED,
  pinned: {},
};

export function loadConfig(dir: string): Config {
  const raw = (readJson(path.join(dir, 'config.json')) ?? {}) as Partial<Config>;
  const cfg: Config = { ...DEFAULT_CONFIG, ...raw };
  // Never share the default array. Ids are kept even when unknown here: custom addons come from addons.json.
  cfg.selected = (Array.isArray(cfg.selected) ? cfg.selected : DEFAULT_SELECTED).filter((g) => typeof g === 'string');
  cfg.pinned = cfg.pinned && typeof cfg.pinned === 'object' && !Array.isArray(cfg.pinned) ? { ...cfg.pinned } : {};
  return cfg;
}

export function saveConfig(dir: string, cfg: Config) {
  return writeJsonAtomic(path.join(dir, 'config.json'), cfg);
}

/** Token lookup order: WFE_GITHUB_TOKEN, SPOKEN_GITHUB_TOKEN, GITHUB_TOKEN, config. */
export function githubToken(cfg: Config, env: NodeJS.ProcessEnv = process.env) {
  return env.WFE_GITHUB_TOKEN || env.SPOKEN_GITHUB_TOKEN || env.GITHUB_TOKEN || cfg.github_token || null;
}
