// The Settings screens: AddOns folder, Spoken language and voice packs, the running-WoW check.
import * as log from '../ui/log.ts';
import type { Deps } from '../types.ts';
import type { IO } from '../ui/prompts.ts';
import { loadConfig, saveConfig } from '../config/config.ts';
import { isLanguageCode, LANGUAGES } from '../catalog/spoken.ts';
import { detect } from '../detect/detect.ts';
import { choose } from '../ui/prompts.ts';
import { paint, sym, clearScreen } from '../ui/term.ts';
import { pickVoicePacks } from './addons.ts';

async function pickAddonsFolder(deps: Deps, io: IO) {
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

async function pickLanguage(deps: Deps, io: IO) {
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

async function toggleRunningCheck(deps: Deps, io: IO) {
  const cfg = loadConfig(deps.configDir);
  const picked = await choose(`When WoW is running (now: ${cfg.check_wow_running ? 'ask first' : 'install anyway'})`, [
    { value: 'off', label: 'Install anyway', hint: 'updates show up after /reload or a restart' },
    { value: 'on', label: 'Ask first', hint: 'warn, and refuse when there is no one to ask' },
  ], io);
  if (picked === null) return;
  saveConfig(deps.configDir, { ...cfg, check_wow_running: picked === 'on' });
  log.info(`${paint('green', sym().ok)} ${picked === 'on' ? 'I will ask before installing while WoW is running.' : 'I will install even while WoW is running.'}`);
}

async function toggleAutoUpdate(deps: Deps, io: IO) {
  const cfg = loadConfig(deps.configDir);
  const picked = await choose(`Auto update mode (now: ${cfg.auto_update ? 'on' : 'off'})`, [
    { value: 'off', label: 'Off', hint: 'I tell you when something is new, you decide' },
    { value: 'on', label: 'On', hint: 'while this menu is open, install new addon versions and a new version of this tool by itself' },
  ], io);
  if (picked === null) return;
  saveConfig(deps.configDir, { ...cfg, auto_update: picked === 'on' });
  log.info(`${paint('green', sym().ok)} Auto update mode ${picked === 'on' ? 'on' : 'off'}.`);
}

export async function settings(deps: Deps, io: IO) {
  for (;;) {
    clearScreen(io.output);
    const what = await choose('Settings', [
      { value: 'folder', label: 'WoW AddOns folder', hint: 'where addons are installed' },
      { value: 'language', label: 'Spoken voice language', hint: 'extra languages for the voiceovers' },
      { value: 'voices', label: 'Spoken voice packs', hint: 'zone and book voices (about 470 MB each)' },
      { value: 'auto', label: 'Auto update mode', hint: 'install everything new by itself' },
      { value: 'running', label: 'Check if WoW is running', hint: 'off: install anyway' },
      { value: 'back', label: 'Back' },
    ], io);
    if (what === 'folder') await pickAddonsFolder(deps, io);
    else if (what === 'language') await pickLanguage(deps, io);
    else if (what === 'auto') await toggleAutoUpdate(deps, io);
    else if (what === 'running') await toggleRunningCheck(deps, io);
    else if (what === 'voices') await pickVoicePacks(deps, io);
    else return;
  }
}
