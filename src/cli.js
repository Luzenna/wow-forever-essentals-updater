// @ts-check
// wow-forever-essentals-updater: install and update the essential addons for
// World of Warcraft: Forever (Spoken, LuzennaForever, NodeSight, Dialogue UI).
// The entry point is main.js; this file only exports main() so tests can call it.
import { parseArgs } from 'node:util';
import * as log from './log.js';
import { appDirs, loadConfig, githubToken, migrateLegacy } from './config.js';
import { MultiSource } from './sources/multi.js';
import { isLanguageCode, GROUPS } from './catalog.js';
import { trySelfUpdate } from './selfupdate.js';
import { update, status, detectCmd, clean, UsageError } from './app.js';
import { runMenu } from './menu.js';

// Stamped in by scripts/build.mjs from package.json (CI sets it to the release version).
const VERSION = /** @type {any} */ (globalThis).__APP_VERSION__ ?? 'dev';

const HELP = `wow-forever-essentals-updater ${VERSION} - essential addons for WoW: Forever

Usage: wow-forever-essentals-updater [command] [options]

With no command in an interactive terminal, a menu opens: install/update, select addons,
status, settings. With --yes, or when not interactive, it installs/updates what is selected.

Commands:
  menu                   open the interactive menu
  update                 install or update the selected addons
  install --only <ids>   (re)install the named items, comma-separated
  status                 show installed vs latest for every item
  detect                 list the AddOns folders found on this computer
  clean                  prune the download cache and leftover temp folders

Options:
  --addons <path>   use this Interface/AddOns folder
  --lang <code>     also install voice packs in this language (e.g. frFR, deDE)
  --dry-run         show what update would do, change nothing
  --yes, -y         never ask questions (for shortcuts and scripts)
  --force           install even while WoW is running
  --no-self-update  don't check GitHub for a newer wow-forever-essentals-updater first
  --pause-on-exit   wait for Enter (max 30 s) before closing the window
  --verbose, -v     more detail
  --version, --help

Addons: ${GROUPS.map((g) => g.title).join(', ')}.
Items: spoken, quests-audio, zones-audio, books-audio, luzenna-forever, nodesight, dialogueui,
       and quests-audio-<lang>, zones-audio-<lang>, books-audio-<lang> with --lang.
Config file: ${appDirs().config}${process.platform === 'win32' ? '\\' : '/'}config.json
GitHub token (optional, for rate limits): WFE_GITHUB_TOKEN or GITHUB_TOKEN.`;

/**
 * @param {string[]} argv
 * @param {{ interactive?: boolean, deps?: Partial<import('./app.js').Deps>, io?: import('./tui.js').IO }} [test]  seams for tests
 */
export async function main(argv, test = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      addons: { type: 'string' },
      lang: { type: 'string' },
      only: { type: 'string' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      force: { type: 'boolean' },
      'no-self-update': { type: 'boolean' },
      'pause-on-exit': { type: 'boolean' },
      verbose: { type: 'boolean', short: 'v' },
      version: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return log.info(HELP), 0;
  if (values.version) return log.info(VERSION), 0;
  log.setVerbose(!!values.verbose);

  if (positionals.length > 1) throw new UsageError(`unexpected argument: ${positionals[1]}`);
  if (values.lang && !isLanguageCode(values.lang)) throw new UsageError(`--lang must look like frFR or deDE, got "${values.lang}"`);
  const interactive = test.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  // No command: ask the user when there is one to ask; shortcuts and scripts (--yes, no terminal) just update.
  const cmd = positionals[0] ?? (interactive && !values.yes && !values['dry-run'] ? 'menu' : 'update');

  const dirs = test.deps?.configDir ? { config: test.deps.configDir, cache: test.deps.cacheDir ?? '' } : appDirs();
  if (!test.deps?.configDir && migrateLegacy(dirs.config)) {
    log.info(`Carried your settings over from spoken-updater to ${dirs.config}`);
  }
  const cfg = loadConfig(dirs.config);
  const deps = {
    source: new MultiSource({ token: githubToken(cfg) }),
    configDir: dirs.config,
    cacheDir: dirs.cache,
    ...test.deps,
  };
  const opts = {
    addons: values.addons,
    lang: values.lang,
    yes: !!values.yes,
    force: !!values.force,
    dryRun: !!values['dry-run'],
    only: values.only ? values.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  };

  switch (cmd) {
    case 'menu':
      if (!interactive) throw new UsageError('the menu needs an interactive terminal; use "update" or "status" instead');
      if (!opts.dryRun && !values['no-self-update']) await trySelfUpdate(VERSION, dirs.cache);
      return runMenu(opts, deps, test.io, VERSION === 'dev' ? '' : VERSION);
    case 'update':
      if (opts.only) throw new UsageError('use "install --only <items>" to pick items');
      if (!opts.dryRun && !values['no-self-update']) await trySelfUpdate(VERSION, dirs.cache);
      return update(opts, deps);
    case 'install':
      if (!opts.only?.length) throw new UsageError('install needs --only <item>[,<item>]');
      if (!opts.dryRun && !values['no-self-update']) await trySelfUpdate(VERSION, dirs.cache);
      return update(opts, deps);
    case 'status':
      return status(opts, deps);
    case 'detect':
      return detectCmd(opts, deps);
    case 'clean':
      return clean(opts, deps);
    default:
      throw new UsageError(`unknown command "${cmd}". Try --help.`);
  }
}

