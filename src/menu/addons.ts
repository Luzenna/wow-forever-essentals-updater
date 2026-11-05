// The menu screens that change which addons you have: pick, voice packs, add, remove.
import * as log from '../ui/log.ts';
import type { Options, Deps } from '../types.ts';
import type { IO } from '../ui/prompts.ts';
import { listGroups, withRequired } from '../catalog/catalog.ts';
import { idsOfGroup } from '../catalog/spoken.ts';
import { BUILTIN } from '../catalog/builtin.ts';
import { loadConfig, saveConfig } from '../config/config.ts';
import { loadState, stateKey } from '../config/state.ts';
import { loadCustom } from '../catalog/custom.ts';
import { addFromGitHub } from '../commands/add.ts';
import { update } from '../commands/update.ts';
import { uninstall } from '../commands/remove.ts';
import { resolveAddons } from '../engine/addons-dir.ts';
import { choose, checklist } from '../ui/prompts.ts';
import { paint, sym, clearScreen } from '../ui/term.ts';

export async function selectAddons(deps: Deps, io: IO) {
  clearScreen(io.output); // like every other screen: no dashboard and menu left on screen above the list
  const cfg = loadConfig(deps.configDir);
  const { entries, problems } = loadCustom(deps.configDir);
  const GROUPS = listGroups(entries);
  const picked = await checklist('Which addons do you want? (they are kept up to date for you)', GROUPS.map((g) => ({
    value: g.id, label: g.title, hint: g.blurb, checked: cfg.selected.includes(g.id),
  })), io);
  if (!picked) return;
  // Ids this tool doesn't list (an addons.json entry that was removed) are dropped here.
  // If addons.json could not be read, its addons are not listed here: keep them selected rather than dropping them.
  const unlisted = problems.length ? cfg.selected.filter((id) => !GROUPS.some((g) => g.id === id)) : [];
  // An addon that cannot work alone brings what it needs (Baganator -> Syndicator).
  const chosen = withRequired(picked, [...BUILTIN, ...entries]);
  const next = { ...cfg, selected: [...GROUPS.map((g) => g.id).filter((id) => chosen.includes(id)), ...unlisted] };
  // Spoken's voice packs are asked about when Spoken is newly ticked, not on every change to some other addon.
  // They stay reachable later under Settings.
  const spokenAdded = next.selected.includes('spoken') && !cfg.selected.includes('spoken');
  saveConfig(deps.configDir, next);
  if (spokenAdded) await pickVoicePacks(deps, io);
  log.info(next.selected.length
    ? `${paint('green', sym().ok)} Saved. You'll get: ${GROUPS.filter((g) => next.selected.includes(g.id)).map((g) => g.title).join(', ')}`
    : 'Nothing selected.');
}

/** Which of Spoken's optional voice packs to get. */
export async function pickVoicePacks(deps: Deps, io: IO) {
  const cfg = loadConfig(deps.configDir);
  const parts = await checklist('Spoken voice packs (the addon and the quest voices are always included)', [
    { value: 'zones', label: 'Zone voices', hint: 'about 470 MB', checked: cfg.include_zones },
    { value: 'books', label: 'Book voices', hint: 'about 470 MB', checked: cfg.include_books },
  ], io);
  if (!parts) return;
  saveConfig(deps.configDir, { ...cfg, include_zones: parts.includes('zones'), include_books: parts.includes('books') });
  log.info(`${paint('green', sym().ok)} Spoken voice packs: ${['quests', ...parts.filter((p) => p === 'zones' || p === 'books')].join(', ')}`);
}

async function addAddon(opts: Options, deps: Deps, io: IO) {
  const text = (await io.ask('GitHub address of the addon (like https://github.com/owner/name), or Enter to cancel: ')).trim();
  if (!text) return 0;
  const added = await addFromGitHub(text, opts, deps, io);
  return added?.installNow ? update({ ...opts, only: [added.id] }, deps) : 0;
}

async function removeAddon(opts: Options, deps: Deps, io: IO) {
  const cfg = loadConfig(deps.configDir);
  const addons = await resolveAddons(opts, deps, cfg);
  const mine = loadState(deps.configDir).installs[stateKey(addons)] ?? {};
  const groups = listGroups(loadCustom(deps.configDir).entries)
    .filter((g) => g.custom || idsOfGroup(g.id, Object.keys(mine)).length > 0);
  if (!groups.length) {
    log.info('Nothing installed by this tool, so there is nothing to remove.');
    return 0;
  }
  const picked = await checklist('Which addons should I remove? (your settings are kept)', groups.map((g) => ({ value: g.id, label: g.title, hint: g.blurb })), io);
  if (!picked?.length) return 0;
  const names = groups.filter((g) => picked.includes(g.id)).map((g) => g.title).join(', ');
  const ok = await choose(`Remove ${names}? Your settings are kept.`, [{ value: 'yes', label: 'Yes, remove it' }, { value: 'no', label: 'No' }], io);
  return ok === 'yes' ? uninstall({ ...opts, only: picked, yes: true }, deps) : 0;
}

export async function manageAddons(opts: Options, deps: Deps, io: IO) {
  clearScreen(io.output);
  const what = await choose('Add or remove addons', [
    { value: 'add', label: 'Add an addon from GitHub', hint: 'any repo that publishes a release zip' },
    { value: 'remove', label: 'Remove an addon', hint: 'deletes its folders; settings are kept' },
    { value: 'back', label: 'Back' },
  ], io);
  if (what === 'add') return addAddon(opts, deps, io);
  if (what === 'remove') return removeAddon(opts, deps, io);
  return null; // backed out: no pause needed
}
