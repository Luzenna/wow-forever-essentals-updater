// @ts-check
// The interactive main menu: a dashboard of your addons, then install/update, pick
// addons, status, settings, quit. Everything it does goes through the same functions
// the commands use; the menu only chooses what to run and keeps the config in step
// with what the user ticks.
import * as log from './log.js';
import { GROUPS, isLanguageCode } from './catalog.js';
import { loadConfig, saveConfig } from './config.js';
import { detect } from './detect/detect.js';
import { makePlan, update, status, makeAsk, UsageError } from './app.js';
import { choose, checklist, hasKeys } from './tui.js';
import { banner, heading, paint, pad, sym, truncate, columns, clearScreen } from './ui.js';

const LANGUAGES = ['enUS', 'frFR', 'deDE', 'esES', 'esMX', 'itIT', 'ptBR', 'ruRU', 'koKR', 'zhCN', 'zhTW'];

/**
 * @typedef {import('./app.js').Options} Options
 * @typedef {import('./app.js').Deps} Deps
 * @typedef {import('./tui.js').IO} IO
 * @typedef {import('./app.js').Plan} Plan
 * @typedef {{ state: 'ok' | 'new' | 'update' | 'problem' | 'off', version: string, note: string, bytes: number }} Row
 */

/** @param {Deps} deps @returns {IO} */
function defaultIO(deps) {
  return { input: process.stdin, output: process.stdout, ask: makeAsk(deps) };
}

/**
 * One dashboard row for an addon group, in plain words.
 * @param {import('./catalog.js').Group} group @param {boolean} selected @param {Plan[]} plans @returns {Row}
 */
export function rowFor(group, selected, plans) {
  const mine = plans.filter((p) => p.item.group === group.id);
  if (!selected || !mine.length) return { state: 'off', version: '', note: 'not selected', bytes: 0 };
  const head = mine.find((p) => p.item.kind === 'addon') ?? mine[0];
  const version = head.installed ?? '';
  const bad = mine.find((p) => p.status === 'error' || (p.status === 'unavailable' && !p.item.optional));
  if (bad) return { state: 'problem', version, note: "couldn't check for updates", bytes: 0 };
  const todo = mine.filter((p) => p.act && p.status !== 'current');
  const size = todo.reduce((n, p) => n + (p.release?.asset.size ?? 0), 0);
  const dl = size ? `  ${paint('dim', `${log.bytes(size)} to download`)}` : '';
  if (!todo.length) return { state: 'ok', version, note: 'up to date', bytes: 0 };
  if (head.status === 'not-installed') return { state: 'new', version, note: `not installed${dl}`, bytes: size };
  const next = head.act && head.release ? ` ${sym().arrow} ${head.release.version}` : '';
  return { state: 'update', version, note: `update available${next}${dl}`, bytes: size };
}

/** @param {Row['state']} state */
function markFor(state) {
  const s = sym();
  if (state === 'ok') return paint('green', s.on);
  if (state === 'new' || state === 'update') return paint('yellow', s.on);
  if (state === 'problem') return paint('red', s.fail);
  return paint('dim', s.off);
}

/**
 * The dashboard: banner, one line per addon, the folder in use. Returns what the
 * menu needs to label its first entry.
 * @param {Options} opts @param {Deps} deps @param {string} version
 */
async function dashboard(opts, deps, version) {
  const cfg = loadConfig(deps.configDir);
  for (const l of banner('WoW Forever  ' + sym().dot + '  Essentials Updater', version ? `v${version}` : '')) log.info(l);
  log.info('\n' + heading('Your addons'));
  if (!cfg.selected.length) {
    log.info(`\n  ${paint('yellow', "No addons selected yet. Pick 'Choose which addons I want' below.")}\n`);
    return { todo: 0, bytes: 0 };
  }
  /** @type {Plan[]} */
  let plans = [];
  let addons = '';
  let failure = '';
  try {
    ({ plans, addons } = await makePlan({ ...opts, only: undefined }, deps));
  } catch (e) {
    failure = /** @type {Error} */ (e).message.split('\n')[0];
  }
  const width = Math.max(...GROUPS.map((g) => g.title.length));
  log.info('');
  let todo = 0, bytes = 0;
  for (const g of GROUPS) {
    const row = failure ? { state: /** @type {const} */ ('off'), version: '', note: cfg.selected.includes(g.id) ? 'not checked' : 'not selected', bytes: 0 } : rowFor(g, cfg.selected.includes(g.id), plans);
    if (row.state === 'new' || row.state === 'update') todo++;
    bytes += row.bytes;
    const dim = row.state === 'off';
    const name = dim ? paint('dim', pad(g.title, width)) : paint('bold', pad(g.title, width));
    const ver = paint('dim', pad(row.version || (dim ? '' : sym().dot), 9));
    const note = row.state === 'ok' ? paint('green', row.note) : row.state === 'problem' ? paint('red', row.note) : row.state === 'off' ? paint('dim', row.note) : paint('yellow', row.note);
    log.info(truncate(`  ${markFor(row.state)}  ${name}  ${ver} ${note}`, columns()));
  }
  if (failure) {
    log.info(`\n  ${paint('red', failure)}\n  ${paint('dim', "Open Settings to choose your WoW AddOns folder.")}`);
  } else {
    log.info(`\n  ${paint('dim', truncate('AddOns folder: ' + addons, columns() - 2))}`);
  }
  return { todo, bytes };
}

/** Let the user read the output before the menu redraws over it. @param {IO} io */
async function pressEnter(io) {
  await io.ask(`\n${paint('dim', 'Press Enter to go back to the menu...')}`);
}

/** @param {Deps} deps @param {IO} io */
async function selectAddons(deps, io) {
  const cfg = loadConfig(deps.configDir);
  const picked = await checklist('Which addons do you want? (they are kept up to date for you)', GROUPS.map((g) => ({
    value: g.id, label: g.title, hint: g.blurb, checked: cfg.selected.includes(g.id),
  })), io);
  if (!picked) return;
  const next = { ...cfg, selected: GROUPS.map((g) => g.id).filter((id) => picked.includes(id)) };
  if (next.selected.includes('spoken')) {
    const parts = await checklist('Spoken voice packs (the addon and the quest voices are always included)', [
      { value: 'zones', label: 'Zone voices', hint: 'about 470 MB', checked: cfg.include_zones },
      { value: 'books', label: 'Book voices', hint: 'about 470 MB', checked: cfg.include_books },
    ], io);
    if (parts) {
      next.include_zones = parts.includes('zones');
      next.include_books = parts.includes('books');
    }
  }
  saveConfig(deps.configDir, next);
  log.info(next.selected.length
    ? `${paint('green', sym().ok)} Saved. You'll get: ${GROUPS.filter((g) => next.selected.includes(g.id)).map((g) => g.title).join(', ')}`
    : 'Nothing selected.');
}

/** @param {Deps} deps @param {IO} io */
async function pickAddonsFolder(deps, io) {
  const cfg = loadConfig(deps.configDir);
  const found = detect({ clientFolder: cfg.client_folder }, deps.env);
  if (!found.length) {
    log.warn(`No AddOns folders found for client folder "${cfg.client_folder}". Pass --addons "<path>" or set addons_path in the config.`);
    return;
  }
  const picked = await choose(`Which WoW AddOns folder should I use? (now: ${cfg.addons_path || 'found automatically'})`, [
    { value: '', label: 'Find it automatically each time' },
    ...found.map((c) => ({ value: c.addons, label: c.addons, hint: `${c.label}${c.forever ? ', Forever' : ''}` })),
  ], io);
  if (picked === null) return;
  saveConfig(deps.configDir, { ...cfg, addons_path: picked });
  log.info(picked ? `${paint('green', sym().ok)} Using ${picked}` : `${paint('green', sym().ok)} I'll find the AddOns folder automatically.`);
}

/** @param {Deps} deps @param {IO} io */
async function pickLanguage(deps, io) {
  const cfg = loadConfig(deps.configDir);
  const picked = await choose(`Spoken voice language, on top of English (now: ${cfg.language})`, [
    ...LANGUAGES.map((l) => ({ value: l, label: l === 'enUS' ? 'enUS (English only)' : l })),
    { value: 'other', label: 'Other code...' },
  ], io);
  if (picked === null) return;
  let language = picked;
  if (picked === 'other') {
    language = (await io.ask('Language code (e.g. frFR): ')).trim();
    if (!isLanguageCode(language)) {
      log.warn(`"${language}" does not look like a language code such as frFR; not changed.`);
      return;
    }
  }
  saveConfig(deps.configDir, { ...cfg, language });
  log.info(`${paint('green', sym().ok)} Spoken voice language: ${language}`);
}

/** @param {Deps} deps @param {IO} io */
async function settings(deps, io) {
  for (;;) {
    clearScreen(io.output);
    const what = await choose('Settings', [
      { value: 'folder', label: 'WoW AddOns folder', hint: 'where addons are installed' },
      { value: 'language', label: 'Spoken voice language', hint: 'extra languages for the voiceovers' },
      { value: 'back', label: 'Back' },
    ], io);
    if (what === 'folder') await pickAddonsFolder(deps, io);
    else if (what === 'language') await pickLanguage(deps, io);
    else return;
  }
}

/**
 * Run the menu until the user exits. Returns the process exit code: 0, or the code of
 * the last install/update when it failed.
 * @param {Options} opts @param {Deps} deps @param {IO} [ioOverride] @param {string} [version]
 */
export async function runMenu(opts, deps, ioOverride, version = '') {
  const io = ioOverride ?? defaultIO(deps);
  let code = 0;
  for (;;) {
    clearScreen(io.output);
    const { todo, bytes } = await dashboard(opts, deps, version);
    const updateHint = todo ? `${todo} to install or update${bytes ? ', ' + log.bytes(bytes) : ''}` : 'everything is up to date';
    const what = await choose('What would you like to do?', [
      { value: 'update', label: 'Install or update my addons', hint: updateHint },
      { value: 'select', label: 'Choose which addons I want' },
      { value: 'status', label: "See what's installed", hint: 'versions in detail' },
      { value: 'settings', label: 'Settings' },
      { value: 'exit', label: 'Quit' },
    ], io);
    if (what === null || what === 'exit') {
      if (hasKeys(io)) log.info(`\n${paint('dim', 'Goodbye! Enjoy Azeroth.')}`);
      return code;
    }
    try {
      if (what === 'select') await selectAddons(deps, io);
      else if (what === 'settings') await settings(deps, io);
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
      log.error(/** @type {Error} */ (e).message);
      if (!(e instanceof UsageError)) code = 1;
      await pressEnter(io);
    }
  }
}
