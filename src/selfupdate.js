// @ts-check
// Best-effort self-update from this tool's own GitHub releases. Only ever runs
// from the packaged executable; every failure is a warning, never an error.
import fs from 'node:fs';
import path from 'node:path';
import sea from 'node:sea';
import { execFileSync } from 'node:child_process';
import * as semver from './semver.js';
import * as log from './log.js';
import { HttpError, USER_AGENT, withRetry } from './http.js';
import { download } from './download.js';

export const SELF_REPO = 'Luzenna/wow-forever-essentals-updater';

/** Release asset for this platform, or null when we don't ship one. */
export function selfAssetName(platform = process.platform, arch = process.arch) {
  if (arch !== 'x64') return null;
  if (platform === 'win32') return 'wow-forever-essentals-updater.exe';
  if (platform === 'linux') return 'wow-forever-essentals-updater-linux-x64';
  return null;
}

/**
 * @param {{ version: string, exe: string, platform?: NodeJS.Platform, arch?: string, cacheDir: string, apiBase?: string, fetchImpl?: typeof fetch,
 *           verify?: (file: string, version: string) => void }} o
 * @returns {Promise<'updated' | 'current' | 'skipped'>}
 */
export async function selfUpdate(o) {
  const name = selfAssetName(o.platform, o.arch);
  if (!name) return 'skipped';
  const doFetch = o.fetchImpl ?? fetch;
  const api = `${o.apiBase ?? 'https://api.github.com'}/repos/${SELF_REPO}/releases/latest`;

  const res = await withRetry(async () => {
    const r = await doFetch(api, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new HttpError(api, r.status, r.headers);
    return r;
  }, { retries: 1 });
  const rel = /** @type {{ tag_name: string, draft?: boolean, prerelease?: boolean, assets: { name: string, size: number, browser_download_url: string, digest?: string | null }[] }} */ (await res.json());

  const latest = semver.clean(rel.tag_name);
  if (!latest || rel.draft || rel.prerelease) return 'current';
  if (semver.compare(latest, o.version) <= 0) return 'current';

  const a = rel.assets.find((x) => x.name === name);
  const sha = a?.digest && /^sha256:([0-9a-f]{64})$/i.exec(a.digest)?.[1].toLowerCase();
  if (!a || !sha) throw new Error(`release ${rel.tag_name} has no verifiable ${name}`);

  log.info(`Updating wow-forever-essentals-updater ${o.version} -> ${latest}...`);
  const dest = path.join(o.cacheDir, 'self', latest, name);
  const { file } = await download(
    { name, url: a.browser_download_url, size: a.size, sha256: sha },
    dest,
    { fetchImpl: o.fetchImpl, retry: { retries: 2 } },
  );

  // Make sure the new binary actually starts and is the version we expect before it replaces us.
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
  (o.verify ?? verifyBinary)(file, latest);

  swapExecutable(o.exe, file);
  fs.rmSync(path.dirname(path.dirname(dest)), { recursive: true, force: true });
  log.info(`Updated to ${latest}. The new version is used from the next run.`);
  return 'updated';
}

/** @param {string} file @param {string} version */
function verifyBinary(file, version) {
  const out = execFileSync(file, ['--version'], { timeout: 15_000, encoding: 'utf8' }).trim();
  if (out !== version) throw new Error(`downloaded build reports "${out}", expected ${version}`);
}

/**
 * Replace the running executable. Windows can't overwrite a running exe but can
 * rename it; Linux can rename over it directly.
 * @param {string} exe @param {string} next
 */
export function swapExecutable(exe, next) {
  const staged = exe + '.new';
  fs.copyFileSync(next, staged);
  try {
    fs.chmodSync(staged, 0o755);
    const old = exe + '.old';
    fs.rmSync(old, { force: true });
    fs.renameSync(exe, old);
    try {
      fs.renameSync(staged, exe);
    } catch (e) {
      fs.renameSync(old, exe);
      throw e;
    }
  } finally {
    fs.rmSync(staged, { force: true });
  }
}

/** Remove the previous executable left behind by an earlier self-update. @param {string} exe */
export function cleanupOld(exe) {
  try {
    fs.rmSync(exe + '.old', { force: true });
  } catch {
    // Still locked by a running older copy; next run.
  }
}

/** The entry point cli.js uses: packaged builds only, warns instead of throwing. @param {string} version @param {string} cacheDir */
export async function trySelfUpdate(version, cacheDir) {
  if (version === 'dev' || !sea.isSea()) return;
  const exe = process.execPath;
  cleanupOld(exe);
  try {
    await selfUpdate({ version, exe, cacheDir });
  } catch (e) {
    log.warn(`Could not check for a wow-forever-essentals-updater update: ${/** @type {Error} */ (e)?.message ?? e}`);
  }
}
