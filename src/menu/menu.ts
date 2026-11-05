// The interactive main menu: a dashboard of your addons, then install/update, pick
// addons, status, settings, quit. Everything it does goes through the same functions
// the commands use; the menu only chooses what to run and keeps the config in step
// with what the user ticks.
import * as log from '../ui/log.ts';
import type { Options, Deps, SelfUpdater } from '../types.ts';
import type { IO } from '../ui/prompts.ts';
import { update } from '../commands/update.ts';
import { status } from '../commands/status.ts';
import { UsageError } from '../errors.ts';
import { makeAsk } from '../ui/ask.ts';
import { choose, hasKeys, stdIO } from '../ui/prompts.ts';
import { paint, clearScreen, sym } from '../ui/term.ts';
import { dashboard } from './dashboard.ts';
import { selectAddons, manageAddons } from './addons.ts';
import { settings } from './settings.ts';

function defaultIO(deps: Deps): IO {
  return stdIO(makeAsk(deps));
}

/** Let the user read the output before the menu redraws over it. */
async function pressEnter(io: IO) {
  await io.ask(`\n${paint('dim', 'Press Enter to go back to the menu...')}`);
}

/**
 * How often an open menu looks for new releases. GitHub allows 60 API requests an hour without a token
 * (even a 304 answer counts) and each look costs about one per addon repo, so without a token it is
 * every 15 minutes; with one (5000 an hour) every 5.
 */
export const REFRESH_MS = 5 * 60 * 1000;
export const REFRESH_MS_ANONYMOUS = 15 * 60 * 1000;

const clock = () => new Date().toTimeString().slice(0, 5);

/**
 * A newer version of this tool: beep, notify, and ask. Yes downloads it and restarts into it (that call only
 * returns when it did not happen). A no is remembered, so the same version is not asked about every 5 minutes.
 */
async function offerSelfUpdate(deps: Deps, self: SelfUpdater, io: IO, version: string, declined: Set<string>) {
  const next = await self.check();
  if (!next || declined.has(next)) return;
  io.output.write('');
  deps.notify?.('WoW Forever: updater update', `Version ${next} is available${version ? ` (you have ${version})` : ''}`);
  const ans = (await io.ask(`
  ${paint('yellow', `wow-forever-essentals-updater ${next} is available${version ? ` (you have ${version})` : ''}.`)}
  Update and restart now? [y/N] `)).trim();
  declined.add(next);
  if (/^y(es)?$/i.test(ans)) {
    await self.apply();
    log.warn("Couldn't update right now; carrying on with this version.");
  }
}

/**
 * Run the menu until the user exits. Returns the process exit code: 0, or the code of
 * the last install/update when it failed.
 *
 * With a real keyboard the menu looks again every `refreshMs` while it waits for a key: it
 * redraws the dashboard and, for an update it has not shown before, rings the terminal bell and
 * sends a desktop notification. Over a pipe it never refreshes (there is nothing to redraw).
 */
export async function runMenu(opts: Options, deps: Deps, ioOverride?: IO, version = '', refreshMs = REFRESH_MS): Promise<number> {
  const io = ioOverride ?? defaultIO(deps);
  const refresh = hasKeys(io) && refreshMs > 0 ? refreshMs : 0;
  let code = 0;
  const seen = new Set<string>();
  const declined = new Set<string>();
  let refreshed = false;
  for (;;) {
    clearScreen(io.output);
    // The source remembers what it fetched; a refresh has to ask again to see anything new.
    if (refreshed) deps.source.invalidate?.();
    const { todo, bytes, found } = await dashboard(opts, deps, version);
    const fresh = [...found].filter(([key]) => !seen.has(key)).map(([, label]) => label);
    for (const key of found.keys()) seen.add(key);
    if (refreshed && fresh.length) {
      const body = fresh.join(', ');
      io.output.write('');
      deps.notify?.('WoW Forever: update available', body);
      log.info(`
  ${paint('yellow', `${sym().on} New: ${body}`)}`);
    }
    if (refreshed && deps.selfUpdate) await offerSelfUpdate(deps, deps.selfUpdate, io, version, declined);
    if (refresh) log.info(`
  ${paint('dim', `Checked ${clock()}, checking again every ${Math.round(refresh / 60000) || '<1'} min`)}`);
    const updateHint = todo ? `${todo} to install or update${bytes ? ', ' + log.bytes(bytes) : ''}` : 'everything is up to date';
    const timer = new AbortController();
    const timeout = refresh ? setTimeout(() => timer.abort(), refresh) : undefined;
    const what = await choose('What would you like to do?', [
      { value: 'update', label: 'Install or update my addons', hint: updateHint },
      { value: 'select', label: 'Choose which addons I want' },
      { value: 'manage', label: 'Add or remove addons...', hint: 'your own GitHub repos, or uninstall' },
      { value: 'status', label: "See what's installed", hint: 'versions in detail' },
      { value: 'settings', label: 'Settings' },
      { value: 'exit', label: 'Quit' },
    ], io, timer.signal);
    clearTimeout(timeout);
    refreshed = timer.signal.aborted;
    if (refreshed) continue;
    if (what === null || what === 'exit') {
      if (hasKeys(io)) log.info(`\n${paint('dim', 'Goodbye! Enjoy Azeroth.')}`);
      return code;
    }
    try {
      if (what === 'select') await selectAddons(deps, io);
      else if (what === 'settings') await settings(deps, io);
      else if (what === 'manage') {
        const r = await manageAddons(opts, deps, io);
        if (r !== null) {
          if (r) code = r;
          await pressEnter(io);
        }
      }
      else if (what === 'status') {
        clearScreen(io.output);
        await status({ ...opts, only: undefined }, deps);
        await pressEnter(io);
      } else if (what === 'update') {
        clearScreen(io.output);
        code = await update({ ...opts, only: undefined }, deps);
        await pressEnter(io);
      }
    } catch (e) {
      // A failed action must not close the menu; show it and carry on.
      log.error((e as Error).message);
      if (!(e instanceof UsageError)) code = 1;
      await pressEnter(io);
    }
  }
}
