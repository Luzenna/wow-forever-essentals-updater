// Remove partial downloads, stale cached zips and leftover staging dirs.
import fs from 'node:fs';
import path from 'node:path';
import * as log from '../ui/log.ts';
import { loadConfig } from '../config/config.ts';
import { catalogFor } from '../catalog/catalog.ts';
import { loadCustom } from '../catalog/custom.ts';
import { detect } from '../detect/detect.ts';
import { cachePath } from '../net/download.ts';
import { workDirFor } from '../disk/swap.ts';
import { acquireLock } from '../disk/lock.ts';
import { treeStats } from '../disk/tree.ts';
import { UsageError } from '../errors.ts';
import type { Options, Deps } from '../types.ts';
import type { Config } from '../config/config.ts';

/**
 * Remove partial downloads, cached zips that aren't the latest release, and
 * leftover staging dirs.
 */
export async function clean(opts: Options, deps: Deps) {
  const cfg = loadConfig(deps.configDir);
  // Don't pull partial downloads or staging dirs out from under a running update.
  let release: ReturnType<typeof acquireLock>;
  try {
    release = acquireLock(deps.configDir);
  } catch (e) {
    if ((e as { usage?: boolean }).usage) throw new UsageError((e as Error).message);
    throw e;
  }
  try {
    return await cleanLocked(opts, deps, cfg);
  } finally {
    release();
  }
}

async function cleanLocked(opts: Options, deps: Deps, cfg: Config) {
  let freed = 0;
  const rm = (p: string) => {
    const s = fs.statSync(p);
    freed += s.isDirectory() ? treeStats(p).bytes : s.size;
    fs.rmSync(p, { recursive: true, force: true });
    log.debug(`removed ${p}`);
  };

  const keep = new Set<string>();
  try {
    for (const item of catalogFor(opts, cfg, loadCustom(deps.configDir).entries)) {
      const rel = await deps.source.latest(item);
      if (rel) keep.add(path.dirname(cachePath(deps.cacheDir, item, rel)));
    }
  } catch (e) {
    log.warn(`could not reach the release source (${(e as Error).message}); removing everything cached`);
  }
  const root = path.join(deps.cacheDir, 'downloads');
  // downloads/<prefix>/<version>/<digest>/<asset>
  for (const prefix of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    for (const ver of fs.readdirSync(path.join(root, prefix))) {
      for (const id of fs.readdirSync(path.join(root, prefix, ver))) {
        const dir = path.join(root, prefix, ver, id);
        if (!keep.has(dir)) rm(dir);
        else for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.part'))) rm(path.join(dir, f));
      }
      if (!fs.readdirSync(path.join(root, prefix, ver)).length) fs.rmdirSync(path.join(root, prefix, ver));
    }
    if (!fs.readdirSync(path.join(root, prefix)).length) fs.rmdirSync(path.join(root, prefix));
  }

  let addons = opts.addons || cfg.addons_path;
  if (!addons) addons = detect({ clientFolder: cfg.client_folder }, deps.env).find((c) => c.forever)?.addons ?? '';
  if (addons) {
    const work = workDirFor(addons);
    if (fs.existsSync(path.join(work, 'journal.json'))) {
      log.warn('an interrupted install is pending; run update first so it can be recovered');
    } else if (fs.existsSync(work)) {
      for (const d of fs.readdirSync(work).filter((d) => /^(staging|bak)-/.test(d))) rm(path.join(work, d));
      try {
        fs.rmdirSync(work);
      } catch { /* not empty */ }
    }
  }
  log.info(`Freed ${log.bytes(freed)}.`);
  return 0;
}
