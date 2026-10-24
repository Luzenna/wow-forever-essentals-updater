// @ts-check
// The update engine: work out what each item needs, then download, extract and
// swap only those items. Every side effect goes through `deps`, so tests can run
// the whole flow against fake servers and fake AddOns trees.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import * as semver from './semver.js';
import * as log from './log.js';
import { buildCatalog, GROUPS } from './catalog.js';
import { loadConfig, saveConfig, loadState, saveState, stateKey } from './config.js';
import { detect } from './detect/detect.js';
import { findChild } from './detect/fold.js';
import { tocFiles, readFolderToc, folderSupports, FOREVER_INTERFACE } from './toc.js';
import { cachePath, download, remainingBytes } from './download.js';
import { extractZip, findAddonRoots, isPlaceholder, uncompressedSize } from './extract.js';
import { swapIn, recover, workDirFor, legacyWorkDirFor, pendingJournal, removeLeftovers } from './swap.js';
import { acquireLock, legacyInstanceRunning } from './lock.js';
import { createProgress } from './progress.js';
import { freeBytes, deviceOf, runningWow } from './platform.js';
import { colorOn, paint, pad, sym, vlen } from './ui.js';

export class UsageError extends Error {}

const MARGIN = 200e6; // keep 200 MB free on every filesystem we write to
const UNPACK_FACTOR = 1.05; // audio barely compresses; exact size is checked again per zip

/**
 * @typedef {object} Deps
 * @property {import('./sources/source.js').Source} source
 * @property {string} configDir
 * @property {string} cacheDir
 * @property {typeof fetch} [fetchImpl]
 * @property {import('./detect/detect.js').Env} [env]
 * @property {() => string[]} [runningWow]
 * @property {(question: string) => Promise<string>} [ask]
 * @property {boolean} [tty]
 *
 * @typedef {object} Options
 * @property {string} [addons]
 * @property {boolean} [yes]
 * @property {boolean} [force]
 * @property {boolean} [dryRun]
 * @property {string} [lang]
 * @property {string[]} [only]
 *
 * @typedef {'current' | 'outdated' | 'not-installed' | 'missing' | 'broken' | 'unavailable' | 'error'} Status
 * @typedef {object} Plan
 * @property {import('./catalog.js').Item} item
 * @property {import('./sources/source.js').Release | null} release
 * @property {Status} status
 * @property {string | null} installed
 * @property {string} reason
 * @property {string[]} folders  folders on disk that belong to the item
 * @property {number} diskBytes
 * @property {boolean} act       will be (re)installed
 */

/** File count and total size of a folder tree. @param {string} dir */
export function treeStats(dir) {
  let files = 0, bytes = 0;
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        files++;
        bytes += fs.statSync(p).size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/**
 * Folder names an item had before this tool ever installed it (e.g. installed by
 * hand or by another manager), guessed from the asset name: "SpokenPlayer-2.3.2.zip"
 * -> SpokenPlayer; the "SpokenQuestsAudioAll" bundle -> SpokenQuestsAudio<Faction>.
 * Items that know their folder names up front ("NodeSight") just look those up.
 * @param {string} addons @param {import('./catalog.js').Item} item @param {import('./sources/source.js').Release} rel
 */
function adoptFolders(addons, item, rel) {
  let names;
  try {
    names = fs.readdirSync(addons, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  if (item.folders) {
    const want = item.folders.map((f) => f.toLowerCase());
    return names.filter((n) => want.includes(n.toLowerCase()));
  }
  const base = rel.asset.name.replace(/-v?\d+\.\d+\.\d+.*\.zip$/i, '').replace(/\.zip$/i, '');
  const exact = names.filter((n) => n.toLowerCase() === base.toLowerCase());
  if (exact.length) return exact;
  if (/All$/.test(base)) {
    const stem = base.slice(0, -3).toLowerCase();
    return names.filter((n) => n.toLowerCase().startsWith(stem) && /^[A-Z]/.test(n.slice(stem.length)));
  }
  return [];
}

/**
 * Compare what's on disk with the latest release. The .toc wins over the state
 * file; the state file supplies folder names and the size baseline.
 * @param {import('./catalog.js').Item} item
 * @param {import('./sources/source.js').Release | null} rel
 * @param {string} addons
 * @param {import('./config.js').ItemState | undefined} st
 * @returns {Plan}
 */
export function inspect(item, rel, addons, st) {
  /** @type {Plan} */
  const plan = { item, release: rel, status: 'current', installed: null, reason: '', folders: [], diskBytes: 0, act: false };
  if (!rel) {
    return { ...plan, status: 'unavailable', reason: item.optional ? 'not published for this language' : 'no release found' };
  }
  const o = { letters: !!item.letterSuffix };
  // Older state files may list placeholder folders the item doesn't own; they're not ours to check.
  const recorded = (st ? Object.keys(st.folders) : adoptFolders(addons, item, rel)).filter(item.owns);
  if (!recorded.length) return { ...plan, status: 'not-installed', reason: 'not installed', act: true };

  /** @type {{ name: string, version: string | null, recordedVersion: string | null }[]} */
  const seen = [];
  for (const name of recorded) {
    const actual = findChild(addons, name, { dirsOnly: true });
    if (!actual) return { ...plan, status: 'missing', reason: `folder ${name} is missing`, act: true };
    const dir = path.join(addons, actual);
    plan.folders.push(actual);
    if (!tocFiles(dir).length) return { ...plan, status: 'broken', reason: `${name} has no .toc`, act: true };
    const s = treeStats(dir);
    plan.diskBytes += s.bytes;
    const rec = st?.folders[name];
    if (rec && (s.files < rec.files * 0.9 || s.files > rec.files * 1.1 || s.bytes < rec.bytes * 0.9 || s.bytes > rec.bytes * 1.1)) {
      return { ...plan, status: 'broken', reason: `${name} looks incomplete (${s.files}/${rec.files} files)`, act: true };
    }
    seen.push({ name, version: readFolderToc(dir)?.version ?? null, recordedVersion: rec?.tocVersion ?? null });
  }

  // The item's version comes from its main folders: those whose .toc carried the
  // release version at install time (this skips tombstones and helper folders that
  // have their own numbering). Without such a record, every versioned folder counts.
  let primary = st ? seen.filter((f) => f.recordedVersion === st.version) : [];
  if (!primary.length) primary = seen.filter((f) => f.version);
  const versions = primary.map((f) => f.version).filter((v) => v !== null);
  const installed = versions.length ? versions.reduce((a, b) => (semver.compare(a, b, o) <= 0 ? a : b)) : st?.version ?? null;
  plan.installed = installed;

  const leftovers = (item.replaces?.folders ?? []).filter((n) => findChild(addons, n, { dirsOnly: true }));
  const exclusionChanged = !!st && [...(st.exclude ?? [])].sort().join() !== [...(item.exclude ?? [])].sort().join();
  if (installed && semver.compare(installed, rel.version, o) === 0) {
    if (leftovers.length) return { ...plan, status: 'outdated', reason: `old folders to remove: ${leftovers.join(', ')}`, act: true };
    if (exclusionChanged) return { ...plan, status: 'outdated', reason: 'zones/books setting changed', act: true };
    return plan;
  }
  // Never downgrade: a newer build (from Wago, or a dev copy) is left alone.
  if (installed && semver.compare(installed, rel.version, o) > 0) return { ...plan, reason: `newer than the latest release (${rel.version})` };
  // Upstream sometimes ships a .toc whose Version differs from the tag. If the
  // folders still hold exactly what we installed from this tag, it is current.
  if (st && st.tag === rel.tag && primary.length && primary.every((f) => f.version === f.recordedVersion)) {
    return { ...plan, installed: st.version };
  }
  return { ...plan, status: 'outdated', reason: `${installed ?? 'unknown'} -> ${rel.version}`, act: true };
}

/** One line of input from the terminal, or deps.ask when a test supplies it. @param {Deps} deps */
export function makeAsk(deps) {
  return deps.ask ?? (async (/** @type {string} */ q) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Without this, Ctrl+C only pauses stdin: the question never settles and the process exits silently with 0.
    rl.on('SIGINT', () => {
      rl.close();
      process.exit(130);
    });
    try {
      return await rl.question(q);
    } finally {
      rl.close();
    }
  });
}

/**
 * Pick the AddOns folder: --addons, then config, then detection (asking when
 * several are found and we may ask).
 * @param {Options} opts @param {Deps} deps @param {import('./config.js').Config} cfg
 */
export async function resolveAddons(opts, deps, cfg) {
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
    const n = Number((await ask(`Install into which one? [1-${found.length}] `)).trim());
    if (Number.isInteger(n) && n >= 1 && n <= found.length) {
      const chosen = found[n - 1].addons;
      saveConfig(deps.configDir, { ...cfg, addons_path: chosen });
      log.info(`Saved choice to ${path.join(deps.configDir, 'config.json')}`);
      return chosen;
    }
  }
}

/** @param {Options} opts @param {import('./config.js').Config} cfg */
export function catalogFor(opts, cfg) {
  // --only can name any item, selected or not.
  const items = buildCatalog({
    language: opts.lang ?? cfg.language, includeZones: cfg.include_zones, includeBooks: cfg.include_books,
    selected: opts.only?.length ? undefined : cfg.selected,
  });
  if (opts.only?.length) {
    const unknown = opts.only.filter((id) => !items.some((i) => i.id === id));
    if (unknown.length) {
      throw new UsageError(`unknown item(s): ${unknown.join(', ')}. Known: ${items.map((i) => i.id).join(', ')}`);
    }
  }
  return items;
}

/**
 * Zips are deleted after each install unless keep_downloads is set, so the cache
 * only needs room for the largest one; AddOns needs room for everything unpacked.
 * @param {Plan[]} plans @param {string} addons @param {string} cacheDir @param {boolean} keepDownloads
 */
function checkSpace(plans, addons, cacheDir, keepDownloads) {
  const need = new Map(); // device -> { bytes, where }
  /** @param {string} p @param {number} n */
  const add = (p, n) => {
    const dev = deviceOf(p);
    const cur = need.get(dev) ?? { bytes: 0, where: p };
    cur.bytes += n;
    need.set(dev, cur);
  };
  let cache = 0;
  for (const p of plans.filter((x) => x.act && x.release)) {
    const rel = /** @type {import('./sources/source.js').Release} */ (p.release);
    const left = remainingBytes(cachePath(cacheDir, p.item, rel), rel.asset.size);
    cache = keepDownloads ? cache + left : Math.max(cache, left);
    add(addons, rel.asset.size * UNPACK_FACTOR);
  }
  add(cacheDir, cache);
  for (const { bytes, where } of need.values()) {
    const free = freeBytes(where);
    if (bytes + MARGIN > free) {
      throw new Error(`not enough disk space on the drive holding ${where}: need ${log.bytes(bytes + MARGIN)}, ${log.bytes(free)} free`);
    }
  }
}

/**
 * Download, unpack and swap one item. Returns bytes downloaded.
 * @param {Plan} plan @param {string} addons @param {Deps} deps @param {import('./config.js').Config} cfg
 * @param {import('./config.js').State} state
 */
async function installItem(plan, addons, deps, cfg, state) {
  const rel = /** @type {import('./sources/source.js').Release} */ (plan.release);
  const L = log.scoped(plan.item.id, plan.item.title);
  L.head(`${plan.reason}`);
  const zip = cachePath(deps.cacheDir, plan.item, rel);
  const left = remainingBytes(zip, rel.asset.size);
  L.info(`${colorOn() ? '' : plan.reason + ': '}${left ? `downloading ${log.bytes(left)}` : 'using cached download'} (${rel.asset.name})`);
  const bar = createProgress(plan.item.id, rel.asset.size, { tty: deps.tty });
  const got = await download(rel.asset, zip, {
    fetchImpl: deps.fetchImpl,
    onProgress: left ? (n) => bar.update(n) : undefined,
    onRetry: (e, n) => L.warn(`download problem (${/** @type {Error} */ (e).message}), retry ${n}`),
  });
  if (left && !got.cached) bar.finish(rel.asset.size);
  L.debug(`verified ${rel.asset.sha256 ? 'sha256 ' + rel.asset.sha256.slice(0, 12) : 'size only (no digest published)'}`);

  const workDir = workDirFor(addons);
  const unpacked = await uncompressedSize(zip);
  if (unpacked + MARGIN > freeBytes(addons)) throw new Error(`not enough disk space to unpack ${log.bytes(unpacked)} into ${addons}`);
  const staging = path.join(workDir, `staging-${process.pid}-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    L.info(`unpacking ${log.bytes(unpacked)}`);
    await extractZip(zip, staging);
    const roots = findAddonRoots(staging);
    const excluded = new Set(plan.item.exclude ?? []);
    const keep = roots.filter((r) => {
      let why = null;
      if (!plan.item.owns(r.name)) why = `not a folder of ${plan.item.id}`;
      else if (plan.item.placeholders && isPlaceholder(r.dir)) why = 'an empty placeholder for a retired folder';
      else if (excluded.has(r.name.toLowerCase())) why = 'switched off in the config';
      if (why) L.debug(`not installing ${r.name} (${why})`);
      return !why;
    });
    if (!keep.length) throw new Error(`the zip contains no ${plan.item.title} addon folders`);
    for (const r of keep) {
      if (!folderSupports(r.dir, FOREVER_INTERFACE)) {
        L.warn(`${r.name}: no .toc lists Interface ${FOREVER_INTERFACE}; the Forever client may mark it incompatible`);
      }
    }
    /** @type {Record<string, import('./config.js').FolderState>} */
    const folders = {};
    for (const r of keep) folders[r.name] = { ...treeStats(r.dir), tocVersion: readFolderToc(r.dir)?.version ?? null };

    // Remove, in the same transaction: folders this item installed before that the
    // new release no longer has (or that are now switched off), and the folders of
    // the retired addons this item replaces. Only folders this item owns, ever.
    const key = stateKey(addons);
    const mine = state.installs[key] ?? {};
    const keepNames = new Set(keep.map((r) => r.name.toLowerCase()));
    const remove = [...new Set([
      ...Object.keys(mine[plan.item.id]?.folders ?? {}),
      ...(plan.item.replaces?.items ?? []).flatMap((id) => Object.keys(mine[id]?.folders ?? {})),
      ...(plan.item.replaces?.folders ?? []),
    ])].filter((n) => plan.item.owns(n) &&!keepNames.has(n.toLowerCase()) && findChild(addons, n, { dirsOnly: true }));
    for (const n of remove) L.info(`removing old folder ${n}`);

    swapIn({ addons, roots: keep, remove, workDir });
    for (const id of plan.item.replaces?.items ?? []) delete mine[id];

    const tocVersion = Object.values(folders).find((f) => f.tocVersion === rel.version)?.tocVersion;
    if (!tocVersion) L.warn(`no .toc reports version ${rel.version}; tracking by release tag ${rel.tag}`);
    state.installs[key] = mine;
    state.installs[key][plan.item.id] = {
      tag: rel.tag, version: rel.version, asset: rel.asset.name, sha256: rel.asset.sha256, exclude: plan.item.exclude ?? [],
      installedAt: new Date().toISOString(), folders,
    };
    saveState(deps.configDir, state);
    L.ok(`installed ${rel.version}: ${keep.map((r) => r.name).join(', ')}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    try {
      fs.rmdirSync(workDir); // only succeeds when empty
    } catch { /* still has other content */ }
  }
  if (!cfg.keep_downloads) {
    fs.rmSync(path.dirname(zip), { recursive: true, force: true });
    // Drop the now-empty <version> and <prefix> dirs too.
    for (let d = path.dirname(path.dirname(zip)), i = 0; i < 2; i++, d = path.dirname(d)) {
      try {
        fs.rmdirSync(d);
      } catch {
        break;
      }
    }
  }
  return got.downloaded;
}

/**
 * Build the plan for every item.
 * @param {Options} opts @param {Deps} deps
 */
export async function makePlan(opts, deps) {
  const cfg = loadConfig(deps.configDir);
  // With --only, other items are neither queried nor reported: an unrelated repo being down must not fail the run.
  const items = catalogFor(opts, cfg).filter((i) => !opts.only?.length || opts.only.includes(i.id));
  const addons = await resolveAddons(opts, deps, cfg);
  const state = loadState(deps.configDir);
  const mine = state.installs[stateKey(addons)] ?? {};
  /** @type {Plan[]} */
  const plans = [];
  for (const item of items) {
    /** @type {Plan} */
    let p;
    try {
      const rel = await deps.source.latest(item);
      p = inspect(item, rel, addons, mine[item.id]);
      if (opts.only?.length) p.act = opts.only.includes(item.id) && !!rel;
    } catch (e) {
      // One broken release (e.g. an unexpected asset layout) must not stop the others.
      p = { item, release: null, status: 'error', installed: null, reason: /** @type {Error} */ (e).message, folders: [], diskBytes: 0, act: false };
    }
    plans.push(p);
  }
  return { cfg, addons, state, plans };
}

/** @param {Plan} p */
const describe = (p) => {
  switch (p.status) {
    case 'current': return 'up to date';
    case 'unavailable': return `skipped: ${p.reason}`;
    default: return p.reason;
  }
};

/**
 * `update` (the default) and `install --only`.
 * Planning is read-only; nothing is written unless something needs doing.
 * @param {Options} opts @param {Deps} deps @returns {Promise<number>} exit code
 */
export async function update(opts, deps) {
  let { cfg, addons, state, plans } = await makePlan(opts, deps);
  const workDir = workDirFor(addons);
  // The old tool's work dir is only ours to recover while no old copy is running (its lock is separate from ours).
  const legacyDirs = legacyInstanceRunning(deps.env) ? [] : [legacyWorkDirFor(addons)];
  const pending = pendingJournal(workDir) || legacyDirs.some(pendingJournal);
  log.info(`AddOns folder: ${addons}`);
  if (!fs.existsSync(addons)) log.info('  (does not exist yet; it will be created)');

  const report = () => {
    for (const p of plans) {
      const L = log.scoped(p.item.id, p.item.title);
      if (p.status === 'error') L.row('fail', p.reason);
      else if (p.status === 'unavailable' && p.item.optional) L.row('skip', describe(p));
      else if (p.status === 'unavailable') L.row('warn', describe(p));
      else if (!p.act && p.status === 'current') L.row('ok', `${p.installed ?? ''} ${p.reason || 'up to date'}`.trim());
      else if (!p.act) L.row('skip', `not selected (${p.reason})`);
    }
  };
  const errored = () => plans.filter((p) => p.status === 'error' || (p.status === 'unavailable' && !p.item.optional));
  let todo = plans.filter((p) => p.act);

  if (opts.dryRun) {
    report();
    if (pending) log.warn('an interrupted install will be recovered on the next real run');
    if (!todo.length) {
      log.info('\nEverything is up to date (dry run).');
      return errored().length ? 1 : 0;
    }
    const total = todo.reduce((n, p) => n + remainingBytes(cachePath(deps.cacheDir, p.item, /** @type {any} */ (p.release)), p.release?.asset.size ?? 0), 0);
    log.info('\nWould install:');
    for (const p of todo) log.info(`  ${p.item.id.padEnd(22)} ${p.reason.padEnd(28)} ${log.bytes(p.release?.asset.size ?? 0)}`);
    log.info(`Total to download: ${log.bytes(total)} (dry run, nothing changed)`);
    return 0;
  }

  if (!todo.length && !pending) {
    report();
    const n = plans.filter((p) => p.status === 'current').length;
    log.info(`\nEverything is up to date (${n} items). 0 bytes downloaded, 0 files changed.`);
    return errored().length ? 1 : 0;
  }

  const running = (deps.runningWow ?? runningWow)();
  if (running.length && !opts.force) {
    throw new UsageError(`World of Warcraft is running (${running.join(', ')}). Close the game first, or pass --force.`);
  }
  if (running.length) log.warn(`WoW is running (${running.join(', ')}); continuing because of --force. /reload or restart the game afterwards.`);

  let release;
  try {
    release = acquireLock(deps.configDir);
  } catch (e) {
    if (/** @type {any} */ (e).usage) throw new UsageError(/** @type {Error} */ (e).message);
    throw e;
  }
  try {
    if (pending) {
      for (const w of [...legacyDirs, workDir]) if (pendingJournal(w)) log.warn(String(recover(w)));
      ({ cfg, addons, state, plans } = await makePlan({ ...opts, addons }, deps));
      todo = plans.filter((p) => p.act);
    }
    for (const w of [...legacyDirs, workDir]) for (const d of removeLeftovers(w)) log.debug(`removed leftover ${d}`);
    report();
    if (!todo.length) {
      log.info('\nEverything is up to date.');
      return errored().length ? 1 : 0;
    }
    checkSpace(todo, addons, deps.cacheDir, cfg.keep_downloads);

    let downloaded = 0;
    /** @type {string[]} */
    const updated = [];
    /** @type {string[]} */
    const failed = errored().map((p) => p.item.id);
    for (const p of todo) {
      try {
        downloaded += await installItem(p, addons, deps, cfg, state);
        updated.push(p.item.id);
      } catch (e) {
        failed.push(p.item.id);
        log.error(`[${p.item.id}] ${/** @type {Error} */ (e).message}`);
      }
    }
    const current = plans.filter((p) => !p.act && p.status === 'current').length;
    const skipped = plans.length - todo.length - current - errored().length;
    if (colorOn()) {
      const titleOf = (/** @type {string} */ id) => plans.find((p) => p.item.id === id)?.item.title ?? id;
      log.info('');
      if (!failed.length) {
        log.info(`${paint(['bold', 'green'], `${sym().ok} All done!`)} ${paint('dim', `${updated.length} updated, ${current} already up to date, ${log.bytes(downloaded)} downloaded`)}`);
      } else {
        log.info(`${paint(['bold', 'red'], `${sym().fail} Finished with problems:`)} ${updated.length} updated, ${failed.length} failed`);
        log.info(`  ${paint('red', failed.map(titleOf).join(', '))} ${paint('dim', "didn't install. Run again to retry; finished downloads are reused.")}`);
      }
    } else {
      log.info(`\nUpdated: ${updated.length}  Up to date: ${current}${skipped ? `  Skipped: ${skipped}` : ''}  Failed: ${failed.length}  Downloaded: ${log.bytes(downloaded)}`);
      if (updated.length) log.info(`  updated: ${updated.join(', ')}`);
      if (failed.length) log.info(`  failed:  ${failed.join(', ')} (run again to retry; finished downloads are reused)`);
    }
    return failed.length ? 1 : 0;
  } finally {
    release();
  }
}

/** @param {Options} opts @param {Deps} deps */
export async function status(opts, deps) {
  const { cfg, addons, plans } = await makePlan(opts, deps);
  log.info(`${paint('dim', 'AddOns folder:')} ${addons}\n`);
  /** @type {Record<string, [string, string]>} */
  const words = {
    outdated: ['update available', 'yellow'], 'not-installed': ['not installed', 'yellow'], missing: ['folder missing', 'yellow'],
    broken: ['needs repair', 'yellow'], error: ['error', 'red'], unavailable: ['n/a', 'dim'],
  };
  const rows = [['ADDON', 'INSTALLED', 'LATEST', 'STATUS', 'DOWNLOAD', 'ID'].map((h) => paint(['bold', 'dim'], h))];
  for (const p of plans) {
    const [word, tint] = p.status === 'current' ? (p.reason ? ['newer than release', 'dim'] : ['up to date', 'green']) : words[p.status] ?? [p.status, 'dim'];
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
  const off = GROUPS.filter((g) => !opts.only?.length && !cfg.selected.includes(g.id));
  if (off.length) log.info(`\nNot selected (left alone): ${off.map((g) => g.title).join(', ')}`);
  // Not p.act: with --only that is set for every named item, installed or not.
  const pending = plans.filter((p) => p.act && p.status !== 'current');
  log.info(pending.length ? `\n${pending.length} item(s) need installing or updating. Run without arguments to update.` : `\n${paint('green', sym().ok)} Everything is up to date.`);
  return 0;
}

/** @param {Options} opts @param {Deps} deps */
export function detectCmd(opts, deps) {
  const cfg = loadConfig(deps.configDir);
  const found = detect({ clientFolder: cfg.client_folder }, deps.env);
  if (cfg.addons_path) log.info(`Configured: ${cfg.addons_path}\n`);
  if (!found.length) {
    log.info(`No AddOns folders found for client folder "${cfg.client_folder}".`);
    return 2;
  }
  for (const c of found) {
    log.info(`${c.addons}${c.exists ? '' : '  (AddOns not created yet)'}`);
    log.info(`    ${c.label}${c.version ? `, game ${c.version}` : ''}${c.forever ? '  [Forever]' : ''}`);
  }
  return 0;
}

/**
 * Remove partial downloads, cached zips that aren't the latest release, and
 * leftover staging dirs.
 * @param {Options} opts @param {Deps} deps
 */
export async function clean(opts, deps) {
  const cfg = loadConfig(deps.configDir);
  // Don't pull partial downloads or staging dirs out from under a running update.
  let release;
  try {
    release = acquireLock(deps.configDir);
  } catch (e) {
    if (/** @type {any} */ (e).usage) throw new UsageError(/** @type {Error} */ (e).message);
    throw e;
  }
  try {
    return await cleanLocked(opts, deps, cfg);
  } finally {
    release();
  }
}

/** @param {Options} opts @param {Deps} deps @param {import('./config.js').Config} cfg */
async function cleanLocked(opts, deps, cfg) {
  let freed = 0;
  /** @param {string} p */
  const rm = (p) => {
    const s = fs.statSync(p);
    freed += s.isDirectory() ? treeStats(p).bytes : s.size;
    fs.rmSync(p, { recursive: true, force: true });
    log.debug(`removed ${p}`);
  };

  /** @type {Set<string>} */
  const keep = new Set();
  try {
    for (const item of catalogFor(opts, cfg)) {
      const rel = await deps.source.latest(item);
      if (rel) keep.add(path.dirname(cachePath(deps.cacheDir, item, rel)));
    }
  } catch (e) {
    log.warn(`could not reach the release source (${/** @type {Error} */ (e).message}); removing everything cached`);
  }
  const root = path.join(deps.cacheDir, 'downloads');
  // downloads/<prefix>/<version>/<digest>/<asset>
  for (const prefix of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    for (const ver of fs.readdirSync(path.join(root, prefix))) {
      for (const id of fs.readdirSync(path.join(root, prefix, ver))) {
        const dir = path.join(root, prefix, ver, id);
        if (!keep.has(dir)) rm(dir);
        else for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.part'))) rm(path.join(dir, f));
      }
      if (!fs.readdirSync(path.join(root, prefix, ver)).length) fs.rmdirSync(path.join(root, prefix, ver));
    }
    if (!fs.readdirSync(path.join(root, prefix)).length) fs.rmdirSync(path.join(root, prefix));
  }

  let addons = opts.addons || cfg.addons_path;
  if (!addons) addons = detect({ clientFolder: cfg.client_folder }, deps.env).find((c) => c.forever)?.addons ?? '';
  if (addons) {
    const work = workDirFor(addons);
    if (fs.existsSync(path.join(work, 'journal.json'))) {
      log.warn('an interrupted install is pending; run update first so it can be recovered');
    } else if (fs.existsSync(work)) {
      for (const d of fs.readdirSync(work).filter((d) => /^(staging|bak)-/.test(d))) rm(path.join(work, d));
      try {
        fs.rmdirSync(work);
      } catch { /* not empty */ }
    }
  }
  log.info(`Freed ${log.bytes(freed)}.`);
  return 0;
}

