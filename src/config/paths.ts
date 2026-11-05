// Where this tool keeps its files. Windows: %APPDATA%\wow-forever-essentals-updater (cache
// under %LOCALAPPDATA%). Linux: XDG dirs (~/.config, ~/.cache).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP = 'wow-forever-essentals-updater';
/** This tool's earlier name; its config and state are carried over once. */
export const LEGACY_APP = 'spoken-updater';

export function appDirs(env: NodeJS.ProcessEnv = process.env, app: string = APP) {
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
 * `dir` is the new config dir.
 */
export function migrateLegacy(dir: string, env: NodeJS.ProcessEnv = process.env) {
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

export function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (e instanceof SyntaxError) throw new Error(`${file} is not valid JSON. Fix it, or delete it to start fresh.`);
    throw new Error(`cannot read ${file}: ${(e as Error).message}`);
  }
}

/**
 * Write JSON atomically (temp file + rename). Does nothing when the content is
 * unchanged, so a no-op run leaves every file untouched. Returns true if written.
 */
export function writeJsonAtomic(file: string, data: unknown) {
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
