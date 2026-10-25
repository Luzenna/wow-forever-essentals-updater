// @ts-check
// wow-forever-essentals-updater: install and update the essential addons for
// World of Warcraft: Forever (Spoken, LuzennaForever, NodeSight, Dialogue UI).
// The entry point is main.js; this file only exports main() so tests can call it.
import { parseArgs } from 'node:util';
import * as log from './log.js';
import { appDirs, loadConfig, saveConfig, githubToken, migrateLegacy } from './config.js';
import { MultiSource } from './sources/multi.js';
import { isLanguageCode, listGroups } from './catalog.js';
import { trySelfUpdate } from './selfupdate.js';
import { update, uninstall, status, detectCmd, clean, makeAsk, catalogFor, UsageError } from './app.js';
import { loadCustom } from './custom.js';
import { runMenu } from './menu.js';
import { addFromGitHub } from './addrepo.js';
import { stdIO } from './tui.js';
import * as semver from './semver.js';

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
  add <repo>             add an addon from GitHub (owner/name or a github.com address)
  remove --only <addons> uninstall addons, e.g. nodesight; your settings are kept
  status                 show installed vs latest for every item
  detect                 list the AddOns folders found on this computer
  clean                  prune the download cache and leftover temp folders

Options:
  --addons <path>   use this Interface/AddOns folder
  --lang <code>     also install voice packs in this language (e.g. frFR, deDE)
  --dry-run         show what update would do, change nothing
  --yes, -y         never ask questions (for shortcuts and scripts)
  --force           install even while WoW is running
  --pin <version>   with install --only <item>: install that version and hold it there
  --unpin           with install --only <item>: stop holding the version
  --overwrite-dev   replace a folder that looks like your own working copy (a link or a .git folder)
  --no-self-update  don't check GitHub for a newer wow-forever-essentals-updater first
  --pause-on-exit   wait for Enter (max 30 s) before closing the window
  --verbose, -v     more detail
  --version, --help

Addons: ${listGroups().map((g) => g.title).join(', ')}.
Items: spoken, quests-audio, zones-audio, books-audio, luzenna-forever, nodesight, dialogueui,
       and quests-audio-<lang>, zones-audio-<lang>, books-audio-<lang> with --lang.
Config files: ${appDirs().config}${process.platform === 'win32' ? '\\' : '/'}config.json and addons.json (your own addons)
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
      pin: { type: 'string' },
      unpin: { type: 'boolean' },
      'overwrite-dev': { type: 'boolean' },
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

  if (positionals.length > (positionals[0] === 'add' ? 2 : 1)) throw new UsageError(`unexpected argument: ${positionals[positionals[0] === 'add' ? 2 : 1]}`);
  if (values.pin && !semver.valid(values.pin, { letters: true })) throw new UsageError(`--pin needs a version like 1.4.0, got "${values.pin}"`);
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
    overwriteDev: !!values['overwrite-dev'],
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
      if (values.pin || values.unpin) {
        if (opts.only.length !== 1) throw new UsageError('--pin and --unpin work on one item at a time: install --only <item> --pin <version>');
        if (values.pin && values.unpin) throw new UsageError('use --pin or --unpin, not both');
        const now = loadConfig(dirs.config);
        catalogFor({ only: opts.only }, now, loadCustom(dirs.config).entries); // refuses an unknown id before anything is saved
        const { [opts.only[0]]: _gone, ...rest } = now.pinned;
        saveConfig(dirs.config, { ...now, pinned: values.pin ? { ...rest, [opts.only[0]]: values.pin } : rest });
        if (!opts.dryRun && !values['no-self-update']) await trySelfUpdate(VERSION, dirs.cache);
        let code = 1;
        try {
          code = await update(opts, deps);
        } finally {
          // A pin that did not install (typo, missing version, dry run) must not stay behind.
          if (code !== 0 || opts.dryRun) saveConfig(dirs.config, now);
        }
        return code;
      }
      if (!opts.dryRun && !values['no-self-update']) await trySelfUpdate(VERSION, dirs.cache);
      return update(opts, deps);
    case 'add': {
      if (!positionals[1]) throw new UsageError('add needs a GitHub repo: add owner/name');
      if (!interactive && !opts.yes) throw new UsageError('add needs --yes when there is no terminal to ask in');
      const added = await addFromGitHub(positionals[1], opts, deps, test.io ?? stdIO(makeAsk(deps)));
      return added?.installNow ? update({ ...opts, only: [added.id] }, deps) : 0;
    }
    case 'remove':
      return uninstall(opts, deps);
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

