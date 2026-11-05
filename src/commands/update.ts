// `update` (the default command) and `install --only`.
import fs from 'node:fs';
import * as log from '../ui/log.ts';
import { cachePath, remainingBytes } from '../net/download.ts';
import { workDirFor, legacyWorkDirFor, recover, pendingJournal, removeLeftovers } from '../disk/swap.ts';
import { acquireLock, legacyInstanceRunning } from '../disk/lock.ts';
import { runningWow } from '../disk/platform.ts';
import { colorOn, paint, sym } from '../ui/term.ts';
import { UsageError } from '../errors.ts';
import { makePlan } from '../engine/plan.ts';
import { checkSpace, installItem } from '../engine/install.ts';
import type { Release } from '../sources/source.ts';
import type { Plan } from '../engine/plan.ts';
import type { Options, Deps } from '../types.ts';

const describe = (p: Plan) => {
  switch (p.status) {
    case 'current': return 'up to date';
    case 'unavailable': return `skipped: ${p.reason}`;
    default: return p.reason;
  }
};

/**
 * `update` (the default) and `install --only`.
 * Planning is read-only; nothing is written unless something needs doing.
 * Resolves to the exit code.
 */
export async function update(opts: Options, deps: Deps): Promise<number> {
  let { cfg, addons, state, plans, problems } = await makePlan(opts, deps);
  for (const w of problems) log.warn(w);
  const workDir = workDirFor(addons);
  // The old tool's work dir is only ours to recover while no old copy is running (its lock is separate from ours).
  const legacyDirs = legacyInstanceRunning(deps.env as unknown as NodeJS.ProcessEnv | undefined) ? [] : [legacyWorkDirFor(addons)];
  const pending = pendingJournal(workDir) || legacyDirs.some(pendingJournal);
  log.info(`AddOns folder: ${addons}`);
  if (!fs.existsSync(addons)) log.info('  (does not exist yet; it will be created)');

  const report = () => {
    for (const p of plans) {
      const L = log.scoped(p.item.id, p.item.title);
      if (p.status === 'error') L.row('fail', p.reason);
      else if (p.status === 'unavailable' && p.item.optional) L.row('skip', describe(p));
      else if (p.status === 'unavailable') L.row('warn', describe(p));
      else if (p.status === 'dev') L.row('skip', p.reason);
      else if (!p.act && p.status === 'current') L.row('ok', `${p.installed ?? ''} ${p.reason || 'up to date'}`.trim());
      else if (!p.act) L.row('skip', `not selected (${p.reason})`);
    }
  };
  const errored = () => plans.filter((p) => p.status === 'error' || (p.status === 'unavailable' && !p.item.optional));
  let todo = plans.filter((p) => p.act);

  if (opts.dryRun) {
    report();
    if (pending) log.warn('an interrupted install will be recovered on the next real run');
    if (!todo.length) {
      log.info('\nEverything is up to date (dry run).');
      return errored().length ? 1 : 0;
    }
    const total = todo.reduce((n, p) => n + remainingBytes(cachePath(deps.cacheDir, p.item, p.release as Release), p.release?.asset.size ?? 0), 0);
    log.info('\nWould install:');
    for (const p of todo) log.info(`  ${p.item.id.padEnd(22)} ${p.reason.padEnd(28)} ${log.bytes(p.release?.asset.size ?? 0)}`);
    log.info(`Total to download: ${log.bytes(total)} (dry run, nothing changed)`);
    return 0;
  }

  if (!todo.length && !pending) {
    report();
    const n = plans.filter((p) => p.status === 'current').length;
    log.info(`\nEverything is up to date (${n} items). 0 bytes downloaded, 0 files changed.`);
    return errored().length ? 1 : 0;
  }

  const running = (deps.runningWow ?? runningWow)();
  if (running.length && !opts.force) {
    throw new UsageError(`World of Warcraft is running (${running.join(', ')}). Close the game first, or pass --force.`);
  }
  if (running.length) log.warn(`WoW is running (${running.join(', ')}); continuing because of --force. /reload or restart the game afterwards.`);

  let release: ReturnType<typeof acquireLock>;
  try {
    release = acquireLock(deps.configDir);
  } catch (e) {
    if ((e as { usage?: boolean }).usage) throw new UsageError((e as Error).message);
    throw e;
  }
  try {
    if (pending) {
      for (const w of [...legacyDirs, workDir]) if (pendingJournal(w)) log.warn(String(recover(w)));
      ({ cfg, addons, state, plans } = await makePlan({ ...opts, addons }, deps));
      todo = plans.filter((p) => p.act);
    }
    for (const w of [...legacyDirs, workDir]) for (const d of removeLeftovers(w)) log.debug(`removed leftover ${d}`);
    report();
    if (!todo.length) {
      log.info('\nEverything is up to date.');
      return errored().length ? 1 : 0;
    }
    checkSpace(todo, addons, deps.cacheDir, cfg.keep_downloads);

    let downloaded = 0;
    const updated: string[] = [];
    const failed: string[] = errored().map((p) => p.item.id);
    for (const p of todo) {
      try {
        downloaded += await installItem(p, addons, deps, cfg, state, opts);
        updated.push(p.item.id);
      } catch (e) {
        failed.push(p.item.id);
        log.error(`[${p.item.id}] ${(e as Error).message}`);
      }
    }
    const current = plans.filter((p) => !p.act && p.status === 'current').length;
    const skipped = plans.length - todo.length - current - errored().length;
    if (colorOn()) {
      const titleOf = (id: string) => plans.find((p) => p.item.id === id)?.item.title ?? id;
      log.info('');
      if (!failed.length) {
        log.info(`${paint(['bold', 'green'], `${sym().ok} All done!`)} ${paint('dim', `${updated.length} updated, ${current} already up to date, ${log.bytes(downloaded)} downloaded`)}`);
      } else {
        log.info(`${paint(['bold', 'red'], `${sym().fail} Finished with problems:`)} ${updated.length} updated, ${failed.length} failed`);
        log.info(`  ${paint('red', failed.map(titleOf).join(', '))} ${paint('dim', "didn't install. Run again to retry; finished downloads are reused.")}`);
      }
    } else {
      log.info(`\nUpdated: ${updated.length}  Up to date: ${current}${skipped ? `  Skipped: ${skipped}` : ''}  Failed: ${failed.length}  Downloaded: ${log.bytes(downloaded)}`);
      if (updated.length) log.info(`  updated: ${updated.join(', ')}`);
      if (failed.length) log.info(`  failed:  ${failed.join(', ')} (run again to retry; finished downloads are reused)`);
    }
    return failed.length ? 1 : 0;
  } finally {
    release();
  }
}
