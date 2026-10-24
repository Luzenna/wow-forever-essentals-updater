// @ts-check
// The interactive main menu: install/update, pick addons, status, settings, exit.
// Everything it does goes through the same functions the commands use; the menu
// only chooses what to run and keeps the config in step with what the user ticks.
import * as log from './log.js';
import { GROUPS, isLanguageCode } from './catalog.js';
import { loadConfig, saveConfig } from './config.js';
import { detect } from './detect/detect.js';
import { makePlan, update, status, makeAsk, UsageError } from './app.js';
import { choose, checklist } from './tui.js';

const LANGUAGES = ['enUS', 'frFR', 'deDE', 'esES', 'esMX', 'itIT', 'ptBR', 'ruRU', 'koKR', 'zhCN', 'zhTW'];

/**
 * @typedef {import('./app.js').Options} Options
 * @typedef {import('./app.js').Deps} Deps
 * @typedef {import('./tui.js').IO} IO
 */

/** @param {Deps} deps @returns {IO} */
function defaultIO(deps) {
  return { input: process.stdin, output: process.stdout, ask: makeAsk(deps) };
}

/** Where the selection stands, e.g. "3 of 4 addons selected, 2 need an install or update". @param {Options} opts @param {Deps} deps */
async function summary(opts, deps) {
  const cfg = loadConfig(deps.configDir);
  const picked = `${cfg.selected.length} of ${GROUPS.length} addons selected`;
  if (!cfg.selected.length) return picked;
  try {
    const { plans } = await makePlan({ ...opts, only: undefined }, deps);
    const todo = plans.filter((p) => p.act).length;
    const bad = plans.filter((p) => p.status === 'error' || (p.status === 'unavailable' && !p.item.optional)).length;
    return `${picked}, ${todo ? `${todo} to install or update` : 'all up to date'}${bad ? `, ${bad} could not be checked` : ''}`;
  } catch (e) {
    return `${picked} (could not check: ${/** @type {Error} */ (e).message.split('\n')[0]})`;
  }
}

/** Let the user read the output before the menu redraws over it. @param {IO} io */
async function pressEnter(io) {
  await io.ask('\nPress Enter to return to the menu...');
}

/** @param {Deps} deps @param {IO} io */
async function selectAddons(deps, io) {
  const cfg = loadConfig(deps.configDir);
  const picked = await checklist('Select the addons to install and keep updated:', GROUPS.map((g) => ({
    value: g.id, label: g.title, hint: g.blurb, checked: cfg.selected.includes(g.id),
  })), io);
  if (!picked) return;
  const next = { ...cfg, selected: GROUPS.map((g) => g.id).filter((id) => picked.includes(id)) };
  if (next.selected.includes('spoken')) {
    const parts = await checklist('Spoken voice packs (the Spoken addon and the Quests audio are always installed):', [
      { value: 'zones', label: 'Zones audio', checked: cfg.include_zones },
      { value: 'books', label: 'Books audio', checked: cfg.include_books },
    ], io);
    if (parts) {
      next.include_zones = parts.includes('zones');
      next.include_books = parts.includes('books');
    }
  }
  saveConfig(deps.configDir, next);
  log.info(next.selected.length ? `Selected: ${GROUPS.filter((g) => next.selected.includes(g.id)).map((g) => g.title).join(', ')}` : 'Nothing selected.');
}

/** @param {Deps} deps @param {IO} io */
async function pickAddonsFolder(deps, io) {
  const cfg = loadConfig(deps.configDir);
  const found = detect({ clientFolder: cfg.client_folder }, deps.env);
  if (!found.length) {
    log.info(`No AddOns folders found for client folder "${cfg.client_folder}". Pass --addons "<path>" or set addons_path in the config.`);
    return;
  }
  const picked = await choose(`AddOns folder (now: ${cfg.addons_path || 'detected automatically'}):`, [
    { value: '', label: 'Detect automatically each time' },
    ...found.map((c) => ({ value: c.addons, label: c.addons, hint: `${c.label}${c.forever ? ', Forever' : ''}` })),
  ], io);
  if (picked === null) return;
  saveConfig(deps.configDir, { ...cfg, addons_path: picked });
  log.info(picked ? `Using ${picked}` : 'Will detect the AddOns folder automatically.');
}

/** @param {Deps} deps @param {IO} io */
async function pickLanguage(deps, io) {
  const cfg = loadConfig(deps.configDir);
  const picked = await choose(`Spoken voice language, in addition to English (now: ${cfg.language}):`, [
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
  log.info(`Spoken voice language: ${language}`);
}

/** @param {Deps} deps @param {IO} io */
async function settings(deps, io) {
  for (;;) {
    const what = await choose('Settings', [
      { value: 'folder', label: 'AddOns folder' },
      { value: 'language', label: 'Spoken voice language' },
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
 * @param {Options} opts @param {Deps} deps @param {IO} [ioOverride]
 */
export async function runMenu(opts, deps, ioOverride) {
  const io = ioOverride ?? defaultIO(deps);
  let code = 0;
  for (;;) {
    const line = await summary(opts, deps);
    const what = await choose(`wow-forever-essentals-updater\n${line}`, [
      { value: 'update', label: 'Install / update selected addons' },
      { value: 'select', label: 'Select addons' },
      { value: 'status', label: 'Status' },
      { value: 'settings', label: 'Settings' },
      { value: 'exit', label: 'Exit' },
    ], io);
    if (what === null || what === 'exit') return code;
    try {
      if (what === 'select') await selectAddons(deps, io);
      else if (what === 'settings') await settings(deps, io);
      else if (what === 'status') {
        await status({ ...opts, only: undefined }, deps);
        await pressEnter(io);
      } else if (what === 'update') {
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
