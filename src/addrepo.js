// @ts-check
// "Add an addon from GitHub": look at a repo's latest release, read the folders its zip
// would install, show them, and on a yes put the addon in addons.json. The zip it
// downloads to look inside stays in the cache, so installing it right after is instant.
import fs from 'node:fs';
import path from 'node:path';
import * as log from './log.js';
import { loadConfig, saveConfig } from './config.js';
import { parseRepo, slug, checkNew, addCustom } from './custom.js';
import { cachePath, download } from './download.js';
import { zipAddonFolders } from './extract.js';
import { findChild } from './detect/fold.js';
import { createProgress } from './progress.js';
import { choose } from './tui.js';
import { paint, sym } from './ui.js';
import { UsageError, resolveAddons } from './app.js';

const BIG = 50e6; // ask before downloading more than this just to look inside

/** @param {string} q @param {import('./tui.js').IO} io */
const yes = async (q, io) => (await choose(q, [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], io)) === 'yes';

/**
 * @param {string} text what the user typed
 * @param {import('./app.js').Options} opts @param {import('./app.js').Deps} deps @param {import('./tui.js').IO} io
 * @param {string} [assetPrefix]  zip name stem to prefer (set on the second pass, see below)
 * @returns {Promise<{ id: string, installNow: boolean } | null>} null when nothing was added
 */
export async function addFromGitHub(text, opts, deps, io, assetPrefix) {
  const repo = parseRepo(text);
  if (!repo) throw new UsageError(`"${text.trim()}" does not look like a GitHub address. Use owner/name or https://github.com/owner/name`);
  const id = slug(repo);
  const repoName = repo.split('/')[1];
  let title = repoName;
  /** @type {import('./catalog.js').Item} */
  const probe = {
    id, group: id, repo, tagMode: 'plain', cacheKey: id, assetPrefix, kind: 'addon', title: repoName, optional: false,
    owns: () => true,
  };

  log.info(`Looking at ${repo}...`);
  const rel = await deps.source.latest(probe);
  if (!rel) throw new UsageError(`${repo} has no release with a .zip file. Only GitHub releases that include a zip are supported.`);
  log.info(`  ${paint('bold', repoName)} ${rel.version}  ${paint('dim', `${rel.asset.name}, ${log.bytes(rel.asset.size)}`)}`);
  if (rel.asset.size > BIG && !opts.yes && !(await yes(`That is a large download (${log.bytes(rel.asset.size)}). Continue?`, io))) return null;

  const zip = cachePath(deps.cacheDir, probe, rel);
  const bar = createProgress(id, rel.asset.size, { tty: deps.tty });
  await download(rel.asset, zip, { fetchImpl: deps.fetchImpl, onProgress: (n) => bar.update(n) });
  bar.finish(rel.asset.size);
  const discard = () => {
    fs.rmSync(path.dirname(zip), { recursive: true, force: true });
    // ...and the now-empty <version> and <id> folders above it.
    for (let d = path.dirname(path.dirname(zip)), i = 0; i < 2; i++, d = path.dirname(d)) {
      try {
        fs.rmdirSync(d);
      } catch {
        break;
      }
    }
  };

  try {
    const folders = await zipAddonFolders(zip);
    if (!folders.length) {
      throw new UsageError(`${repo}'s zip has no addon folder in it (nothing like Name/Name.toc). It may not be a packaged addon.`);
    }
    // The install prefers the zip named after the addon folder; if that is a different zip than the one just
    // inspected (a release with several), look again at that one so the folders shown are the ones installed.
    if (!assetPrefix) {
      const real = await deps.source.latest({ ...probe, assetPrefix: folders[0] });
      if (real && real.asset.name !== rel.asset.name) {
        discard();
        return addFromGitHub(text, opts, deps, io, folders[0]);
      }
    }
    // One folder: its name is the friendliest title. Several: the repo name.
    if (folders.length === 1) title = folders[0];
    const problem = checkNew(deps.configDir, { id, repo, folders, title });
    if (problem) throw new UsageError(problem);

    const cfg = loadConfig(deps.configDir);
    const addons = await resolveAddons(opts, deps, cfg);
    const existing = folders.filter((f) => findChild(addons, f, { dirsOnly: true }));
    log.info(`  It installs: ${folders.join(', ')}`);
    if (existing.length) log.warn(`${existing.join(', ')} already exist${existing.length === 1 ? 's' : ''} in AddOns and would be replaced by this addon.`);
    log.info(paint('dim', '  Only add addons from authors you trust.'));
    if (opts.dryRun) {
      discard();
      log.info('Dry run: nothing added.');
      return null;
    }
    if (!opts.yes && !(await yes(`Add ${title}?`, io))) {
      discard();
      log.info('Nothing added.');
      return null;
    }

    addCustom(deps.configDir, { id, repo, folders, title });
    saveConfig(deps.configDir, { ...cfg, selected: [...new Set([...cfg.selected, id])] });
    log.info(`${paint('green', sym().ok)} Added ${title}. It is in your list now.`);
    return { id, installNow: !opts.yes && (await yes(`Install ${title} now?`, io)) };
  } catch (e) {
    discard();
    throw e;
  }
}
