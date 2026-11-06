// The dashboard at the top of the menu: banner, one line per addon, the folder in use.
import * as log from '../ui/log.ts';
import type { Options, Deps } from '../types.ts';
import type { Group } from '../catalog/catalog.ts';
import type { Plan } from '../engine/plan.ts';
import { listGroups } from '../catalog/catalog.ts';
import { loadConfig } from '../config/config.ts';
import { loadCustom } from '../catalog/custom.ts';
import { makePlan } from '../engine/plan.ts';
import { banner, heading, paint, pad, sym, truncate, columns } from '../ui/term.ts';

export interface Row { state: 'ok' | 'new' | 'update' | 'problem' | 'off' | 'dev'; version: string; note: string; bytes: number }

/**
 * One dashboard row for an addon group, in plain words.
 */
export function rowFor(group: Group, selected: boolean, plans: Plan[]): Row {
  const mine = plans.filter((p) => p.item.group === group.id);
  if (!selected || !mine.length) return { state: 'off', version: '', note: 'not selected', bytes: 0 };
  const head = mine.find((p) => p.item.kind === 'addon') ?? mine[0];
  const version = head.installed ?? '';
  const dev = mine.find((p) => p.status === 'dev');
  if (dev) return { state: 'dev', version, note: 'developer copy, left alone', bytes: 0 };
  const bad = mine.find((p) => p.status === 'error' || (p.status === 'unavailable' && !p.item.optional));
  if (bad) {
    // Say why when we know (rate limit, site down...), so a failed row is not a mystery.
    const why = (bad.reason ?? '').replace(/\s+/g, ' ').trim();
    return { state: 'problem', version, note: `couldn't check for updates${why ? `: ${why.length > 50 ? `${why.slice(0, 49)}…` : why}` : ''}`, bytes: 0 };
  }
  const todo = mine.filter((p) => p.act && p.status !== 'current');
  const size = todo.reduce((n, p) => n + (p.release?.asset.size ?? 0), 0);
  const dl = size ? `  ${paint('dim', `${log.bytes(size)} to download`)}` : '';
  const held = head.item.pin ? ` (held at ${head.item.pin})` : '';
  if (!todo.length) return { state: 'ok', version, note: `up to date${held}`, bytes: 0 };
  if (head.status === 'not-installed') return { state: 'new', version, note: `not installed${dl}`, bytes: size };
  const next = head.act && head.release ? ` ${sym().arrow} ${head.release.version}` : '';
  return { state: 'update', version, note: `update available${next}${held}${dl}`, bytes: size };
}

function markFor(state: Row['state']) {
  const s = sym();
  if (state === 'ok') return paint('green', s.on);
  if (state === 'new' || state === 'update') return paint('yellow', s.on);
  if (state === 'problem') return paint('red', s.fail);
  if (state === 'dev') return paint('cyan', s.on);
  return paint('dim', s.off);
}

/**
 * The dashboard: banner, one line per addon, the folder in use. Returns what the
 * menu needs to label its first entry.
 */
export async function dashboard(opts: Options, deps: Deps, version: string) {
  const cfg = loadConfig(deps.configDir);
  const { entries: custom, problems } = loadCustom(deps.configDir);
  const GROUPS = listGroups(custom);
  for (const l of banner('WoW Forever  ' + sym().dot + '  Essentials Updater', version ? `v${version}` : '')) log.info(l);
  log.info('\n' + heading('Your addons'));
  for (const w of problems) log.warn(truncate(w, columns() - 2));
  if (!cfg.selected.length) {
    log.info(`\n  ${paint('yellow', "No addons selected yet. Pick 'Choose which addons I want' below.")}\n`);
    return { todo: 0, bytes: 0, found: new Map<string, string>() };
  }
  let plans: Plan[] = [];
  let addons = '';
  let failure = '';
  try {
    ({ plans, addons } = await makePlan({ ...opts, only: undefined }, deps));
  } catch (e) {
    failure = (e as Error).message.split('\n')[0];
  }
  const width = Math.max(...GROUPS.map((g) => g.title.length));
  log.info('');
  let todo = 0, bytes = 0;
  // What is waiting, keyed by addon and the version on offer, so the menu can tell a new one from one it has shown.
  const found = new Map<string, string>();
  for (const g of GROUPS) {
    const row = failure ? { state: 'off' as const, version: '', note: cfg.selected.includes(g.id) ? 'not checked' : 'not selected', bytes: 0 } : rowFor(g, cfg.selected.includes(g.id), plans);
    if (row.state === 'new' || row.state === 'update') {
      todo++;
      const head = plans.find((p) => p.item.group === g.id && p.item.kind === 'addon') ?? plans.find((p) => p.item.group === g.id);
      const next = head?.release?.version ?? '';
      found.set(`${g.id}@${next}`, `${g.title}${next ? ' ' + next : ''}`);
    }
    bytes += row.bytes;
    const dim = row.state === 'off';
    const name = dim ? paint('dim', pad(g.title, width)) : paint('bold', pad(g.title, width));
    const ver = paint('dim', pad(row.version || (dim ? '' : sym().dot), 9));
    const note = row.state === 'ok' ? paint('green', row.note) : row.state === 'problem' ? paint('red', row.note) : row.state === 'off' ? paint('dim', row.note) : row.state === 'dev' ? paint('cyan', row.note) : paint('yellow', row.note);
    log.info(truncate(`  ${markFor(row.state)}  ${name}  ${ver} ${note}`, columns()));
  }
  if (failure) {
    log.info(`\n  ${paint('red', failure)}\n  ${paint('dim', "Open Settings to choose your WoW AddOns folder.")}`);
  } else {
    log.info(`\n  ${paint('dim', truncate('AddOns folder: ' + addons, columns() - 2))}`);
  }
  return { todo, bytes, found };
}
