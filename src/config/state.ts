// state.json: what this tool installed, per AddOns folder.
import path from 'node:path';
import { readJson, writeJsonAtomic } from './paths.ts';

export interface FolderState { files: number; bytes: number; tocVersion: string | null }
export interface ItemState {
  /** release tag installed, e.g. "quests-audio/v2.2.1" */
  tag: string;
  /** release version installed */
  version: string;
  asset: string;
  sha256: string | null;
  /** folders left out at install (zones/books switched off) */
  exclude?: string[];
  installedAt: string;
  folders: Record<string, FolderState>;
}
export interface State { schema: 1; installs: Record<string, Record<string, ItemState>> }

export function loadState(dir: string): State {
  const raw = readJson(path.join(dir, 'state.json'));
  return raw?.schema === 1 ? raw : { schema: 1, installs: {} };
}

export function saveState(dir: string, state: State) {
  return writeJsonAtomic(path.join(dir, 'state.json'), state);
}

/** State is keyed per AddOns folder so several WoW installs are tracked separately. */
export function stateKey(addons: string) {
  const p = path.resolve(addons);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}
