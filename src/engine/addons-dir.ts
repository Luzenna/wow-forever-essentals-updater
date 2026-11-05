import path from 'node:path';
import * as log from '../ui/log.ts';
import { saveConfig } from '../config/config.ts';
import { detect, isForeverFolder } from '../detect/detect.ts';
import { makeAsk } from '../ui/ask.ts';
import { UsageError } from '../errors.ts';
import type { Options, Deps } from '../types.ts';
import type { Config } from '../config/config.ts';

/**
 * Pick the AddOns folder: --addons, then config, then detection (asking when
 * several are found and we may ask).
 */
export async function resolveAddons(opts: Options, deps: Deps, cfg: Config): Promise<string> {
  if (opts.addons) return path.resolve(opts.addons);
  if (cfg.addons_path) return path.resolve(cfg.addons_path);
  const found = detect({ clientFolder: cfg.client_folder }, deps.env);
  if (!found.length) {
    throw new UsageError(
      `no WoW Forever AddOns folder found (looked for World of Warcraft/${cfg.client_folder}).\n` +
      '  Pass --addons "<path to Interface/AddOns>" or set addons_path in the config.');
  }
  const confirmed = found.filter((c) => c.forever);
  if (confirmed.length === 1) return confirmed[0].addons;
  // Several installs: the one in the _forever_ client folder is the default.
  const preferred = found.filter(isForeverFolder);
  if (preferred.length === 1) {
    log.debug(`several WoW installs found; using the _forever_ one: ${preferred[0].addons}`);
    return preferred[0].addons;
  }
  if (found.length === 1) {
    log.warn(`using ${found[0].addons} (could not confirm it is the 1.60.x Forever client)`);
    return found[0].addons;
  }
  const list = found.map((c, i) => `  ${i + 1}) ${c.addons}\n     ${c.label}${c.version ? `, game ${c.version}` : ''}${c.forever ? ' [Forever]' : ''}`).join('\n');
  if (opts.yes || !(deps.tty ?? process.stdin.isTTY)) {
    throw new UsageError(`several AddOns folders found; choose one with --addons or addons_path in the config:\n${list}`);
  }
  log.info(`Several WoW installs were found:\n${list}`);
  const ask = makeAsk(deps);
  for (;;) {
    // The list is sorted best guess first, so Enter takes 1 when that guess is a Forever install.
    const fallback = found[0].forever || isForeverFolder(found[0]);
    const answer = (await ask(`Install into which one? [1-${found.length}${fallback ? ', Enter = 1' : ''}] `)).trim();
    const n = answer === '' && fallback ? 1 : Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= found.length) {
      const chosen = found[n - 1].addons;
      saveConfig(deps.configDir, { ...cfg, addons_path: chosen });
      log.info(`Saved choice to ${path.join(deps.configDir, 'config.json')}`);
      return chosen;
    }
  }
}
