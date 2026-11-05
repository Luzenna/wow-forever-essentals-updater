import * as log from '../ui/log.ts';
import { listGroups } from '../catalog/catalog.ts';
import { paint, pad, sym, vlen } from '../ui/term.ts';
import { makePlan } from '../engine/plan.ts';
import type { Options, Deps } from '../types.ts';

export async function status(opts: Options, deps: Deps) {
  const { cfg, addons, plans, custom, problems } = await makePlan(opts, deps);
  for (const w of problems) log.warn(w);
  log.info(`${paint('dim', 'AddOns folder:')} ${addons}\n`);
  const words: Record<string, [string, string]> = {
    outdated: ['update available', 'yellow'], 'not-installed': ['not installed', 'yellow'], missing: ['folder missing', 'yellow'],
    broken: ['needs repair', 'yellow'], error: ['error', 'red'], unavailable: ['n/a', 'dim'], dev: ['developer copy', 'cyan'],
  };
  const rows = [['ADDON', 'INSTALLED', 'LATEST', 'STATUS', 'DOWNLOAD', 'ID'].map((h) => paint(['bold', 'dim'], h))];
  for (const p of plans) {
    const [word, tint] = p.status === 'current' ? (p.reason ? ['newer than release', 'dim'] : p.item.pin ? [`held at ${p.item.pin}`, 'cyan'] : ['up to date', 'green']) : words[p.status] ?? [p.status, 'dim'];
    rows.push([
      paint('bold', p.item.title),
      p.installed ?? '-',
      p.release?.version ?? '-',
      paint(tint, word),
      p.release && p.act && p.status !== 'current' ? log.bytes(p.release.asset.size) : '-',
      paint('dim', p.item.id),
    ]);
  }
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => vlen(r[c]))));
  for (const r of rows) log.info('  ' + r.map((cell, c) => pad(cell, w[c])).join('   ').trimEnd());
  const off = listGroups(custom).filter((g) => !opts.only?.length && !cfg.selected.includes(g.id));
  if (off.length) log.info(`\nNot selected (left alone): ${off.map((g) => g.title).join(', ')}`);
  // Not p.act: with --only that is set for every named item, installed or not.
  const pending = plans.filter((p) => p.act && p.status !== 'current');
  log.info(pending.length ? `\n${pending.length} item(s) need installing or updating. Run without arguments to update.` : `\n${paint('green', sym().ok)} Everything is up to date.`);
  return 0;
}
