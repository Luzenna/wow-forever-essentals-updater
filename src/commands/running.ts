// The "is WoW running?" check shared by update and remove. In a terminal it is a warning the user
// can wave through; with --force it is only a note; unattended (--yes, no terminal) it still refuses,
// because nobody is there to say it is fine.
import * as log from '../ui/log.ts';
import type { Options, Deps } from '../types.ts';
import { runningWow } from '../disk/platform.ts';
import { UsageError } from '../errors.ts';
import { makeAsk } from '../ui/ask.ts';

export async function checkWowClosed(opts: Options, deps: Deps): Promise<void> {
  const running = (deps.runningWow ?? runningWow)();
  if (!running.length) return;
  const names = running.join(', ');
  const refuse = () => new UsageError(`World of Warcraft is running (${names}). Close the game first, or pass --force.`);
  if (!opts.force) {
    if (opts.yes || !(deps.tty ?? process.stdin.isTTY)) throw refuse();
    log.warn(`World of Warcraft is running (${names}).`);
    log.info('  An update only shows up after /reload or a restart, and Windows can refuse to replace a file the game has open.');
    const ans = (await makeAsk(deps)('Continue anyway? [y/N] ')).trim();
    if (!/^y(es)?$/i.test(ans)) throw refuse();
  }
  log.warn(`WoW is running (${names}); continuing anyway. /reload or restart the game afterwards.`);
}
