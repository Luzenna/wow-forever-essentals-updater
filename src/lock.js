// @ts-check
// One wow-forever-essentals-updater at a time: a second copy (e.g. a Steam shortcut launched
// twice) must not roll back the first one's swap or append to the same download.
import fs from 'node:fs';
import path from 'node:path';
import { appDirs, LEGACY_APP } from './config.js';

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}

/**
 * Whether a copy of this tool under its old name (spoken-updater) is running right now.
 * Its lock lives in its own config dir, so ours doesn't exclude it.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function legacyInstanceRunning(env = process.env) {
  try {
    const pid = Number(fs.readFileSync(path.join(appDirs(env, LEGACY_APP).config, 'spoken-updater.lock'), 'utf8').trim());
    return !!pid && pid !== process.pid && alive(pid);
  } catch {
    return false;
  }
}

/**
 * Take the lock or throw. Returns a release function. A lock left behind by a
 * process that no longer exists is taken over.
 * @param {string} dir
 */
export function acquireLock(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'wow-forever-essentals-updater.lock');
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => fs.rmSync(file, { force: true });
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(file, 'utf8').trim());
      if (pid && pid !== process.pid && alive(pid)) {
        throw Object.assign(new Error(`another wow-forever-essentals-updater is already running (pid ${pid}). Wait for it to finish.`), { usage: true });
      }
      fs.rmSync(file, { force: true }); // stale
    }
  }
  throw new Error(`could not take the lock ${file}`);
}
