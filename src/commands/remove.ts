// Remove addons: `remove --only <addon>`.
import fs from 'node:fs';
import * as log from '../ui/log.ts';
import { buildCatalog, listGroups } from '../catalog/catalog.ts';
import { idsOfGroup, isSpokenFolder } from '../catalog/spoken.ts';
import { loadConfig, saveConfig } from '../config/config.ts';
import { loadState, saveState, stateKey } from '../config/state.ts';
import { loadCustom, removeCustom } from '../catalog/custom.ts';
import { findChild } from '../disk/fold.ts';
import { swapIn, workDirFor, legacyWorkDirFor, pendingJournal } from '../disk/swap.ts';
import { acquireLock } from '../disk/lock.ts';
import { devCopyReason } from '../disk/platform.ts';
import { checkWowClosed } from './running.ts';
import { paint } from '../ui/term.ts';
import { makeAsk } from '../ui/ask.ts';
import { UsageError } from '../errors.ts';
import { resolveAddons } from '../engine/addons-dir.ts';
import type { Options, Deps } from '../types.ts';
import type { Group } from '../catalog/catalog.ts';

/**
 * Remove addons: move the folders this tool installed for them into the backup, delete
 * the backup, and forget them (state, selection, pins, and the addons.json entry for a custom one).
 * An addon whose folders are already gone is still forgotten. Settings in WTF are never touched.
 * `opts.only` names addon groups, e.g. "nodesight".
 * Resolves to the exit code.
 */
export async function uninstall(opts: Options, deps: Deps): Promise<number> {
  const ids = opts.only ?? [];
  if (!ids.length) throw new UsageError('remove needs --only <addon>[,<addon>]');
  const { entries: custom } = loadCustom(deps.configDir);
  const groups = listGroups(custom);
  const unknown = ids.filter((id) => !groups.some((g) => g.id === id));
  if (unknown.length) throw new UsageError(`unknown addon(s): ${unknown.join(', ')}. Known: ${groups.map((g) => g.id).join(', ')}`);
  const addons = await resolveAddons(opts, deps, loadConfig(deps.configDir));
  const key = stateKey(addons);
  const workDir = workDirFor(addons);
  const L = (g: Group) => log.scoped(g.id, g.title);

  // What to do for each addon, from the state on disk right now. Run again once the lock is held.
  const makeJobs = () => {
    const cfg = loadConfig(deps.configDir);
    const owner = new Map(buildCatalog({ language: 'enUS', includeZones: true, includeBooks: true, custom }).map((i) => [i.group, i.owns]));
    const state = loadState(deps.configDir);
    const mine = state.installs[key] ?? {};
    return {
      state, mine, cfg,
      jobs: ids.map((id) => {
        const group = groups.find((g) => g.id === id) as Group;
        const owns = id === 'spoken' ? isSpokenFolder : owner.get(id);
        const stateIds = idsOfGroup(id, Object.keys(mine));
        const recorded = [...new Set(stateIds.flatMap((sid) => Object.keys(mine[sid]?.folders ?? {})))];
        const folders = recorded.map((n) => findChild(addons, n, { dirsOnly: true })).filter((n) => !!n && !!owns?.(n)) as string[];
        const pins = idsOfGroup(id, Object.keys(cfg.pinned));
        const known = stateIds.length > 0 || group.custom || cfg.selected.includes(id) || pins.length > 0;
        return { group, stateIds, folders, pins, known };
      }),
    };
  };

  /** Drop jobs that are refused or have nothing to do, saying why. */
  const usable = (jobs: ReturnType<typeof makeJobs>['jobs']) => {
    let refused = 0;
    const go = jobs.filter((j) => {
      if (!j.known) {
        L(j.group).row('skip', 'not installed, nothing to remove');
        return false;
      }
      const dev = opts.overwriteDev ? null : j.folders.map((f) => [f, devCopyReason(addons, f)] as const).find(([, why]) => why);
      if (dev) {
        L(j.group).row('warn', `${dev[0]} ${dev[1]}, so it was left alone (pass --overwrite-dev to remove it anyway)`);
        refused++;
        return false;
      }
      return true;
    });
    return { go, refused };
  };

  const first = usable(makeJobs().jobs);
  let code = first.refused ? 1 : 0;
  if (!first.go.length) return code;
  for (const j of first.go) log.info(`${paint('bold', j.group.title)}: ${j.folders.length ? j.folders.join(', ') : 'folders already gone; it will just be forgotten'}`);
  if (opts.dryRun) {
    log.info('Would remove the above (dry run, nothing changed).');
    return code;
  }

  // Check the game and ask before locking, but do the real work from a fresh look at the state under the lock.
  await checkWowClosed(opts, deps);
  if (!opts.yes) {
    if (!(deps.tty ?? process.stdin.isTTY)) throw new UsageError('remove needs --yes when there is no terminal to ask in');
    const ans = (await makeAsk(deps)(`Remove ${first.go.map((j) => j.group.title).join(', ')}? Your settings in WTF are kept. [y/N] `)).trim();
    if (!/^y(es)?$/i.test(ans)) {
      log.info('Nothing removed.');
      return code;
    }
  }
  let release: ReturnType<typeof acquireLock>;
  try {
    release = acquireLock(deps.configDir);
  } catch (e) {
    if ((e as { usage?: boolean }).usage) throw new UsageError((e as Error).message);
    throw e;
  }
  try {
    if (pendingJournal(workDir) || pendingJournal(legacyWorkDirFor(addons))) {
      throw new UsageError('an interrupted install is waiting to be recovered; run update first, then remove');
    }
    const now = makeJobs();
    const { go } = usable(now.jobs.filter((j) => first.go.some((f) => f.group.id === j.group.id)));
    for (const j of go) {
      try {
        if (j.folders.length) swapIn({ addons, roots: [], remove: j.folders, workDir });
      } catch (e) {
        L(j.group).row('fail', (e as Error).message);
        code = 1;
        continue;
      }
      for (const sid of j.stateIds) delete now.mine[sid];
      saveState(deps.configDir, now.state);
      const cfg = loadConfig(deps.configDir);
      const pinned = { ...cfg.pinned };
      for (const pid of j.pins) delete pinned[pid];
      saveConfig(deps.configDir, { ...cfg, selected: cfg.selected.filter((g) => g !== j.group.id), pinned });
      if (j.group.custom) {
        try {
          removeCustom(deps.configDir, j.group.id);
        } catch (e) {
          L(j.group).row('warn', `${(e as Error).message}`);
        }
      }
      L(j.group).row('ok', j.folders.length ? `removed ${j.folders.join(', ')}` : 'removed from your list');
    }
    try {
      fs.rmdirSync(workDir); // only succeeds when empty
    } catch { /* still has other content */ }
  } finally {
    release();
  }
  return code;
}
