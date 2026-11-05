// Best-effort self-update from this tool's own GitHub releases. Only ever runs
// from the packaged executable; every failure is a warning, never an error.
import fs from 'node:fs';
import path from 'node:path';
import sea from 'node:sea';
import { execFileSync, spawnSync } from 'node:child_process';
import * as semver from './semver.ts';
import * as log from './ui/log.ts';
import { HttpError, USER_AGENT, withRetry } from './net/http.ts';
import { download } from './net/download.ts';

export const SELF_REPO = 'Luzenna/wow-forever-essentals-updater';

/** Release asset for this platform, or null when we don't ship one. */
export function selfAssetName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  if (arch !== 'x64') return null;
  if (platform === 'win32') return 'wow-forever-essentals-updater.exe';
  if (platform === 'linux') return 'wow-forever-essentals-updater-linux-x64';
  return null;
}

export async function selfUpdate(o: {
  version: string;
  exe: string;
  platform?: NodeJS.Platform;
  arch?: string;
  cacheDir: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  verify?: (file: string, version: string) => void;
}): Promise<'updated' | 'current' | 'skipped'> {
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
  const rel = (await res.json()) as {
    tag_name: string;
    draft?: boolean;
    prerelease?: boolean;
    assets: { name: string; size: number; browser_download_url: string; digest?: string | null }[];
  };

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
  log.info(`Updated to ${latest}.`);
  return 'updated';
}

function verifyBinary(file: string, version: string): void {
  const out = execFileSync(file, ['--version'], { timeout: 15_000, encoding: 'utf8' }).trim();
  if (out !== version) throw new Error(`downloaded build reports "${out}", expected ${version}`);
}

/**
 * Replace the running executable. Windows can't overwrite a running exe but can
 * rename it; Linux can rename over it directly.
 */
export function swapExecutable(exe: string, next: string): void {
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

/** Remove the previous executable left behind by an earlier self-update. */
export function cleanupOld(exe: string): void {
  try {
    fs.rmSync(exe + '.old', { force: true });
  } catch {
    // Still locked by a running older copy; next run.
  }
}

/** Set in the environment of the restarted copy, which must not look for an update again. */
export const RELAUNCHED = 'WFE_RELAUNCHED';

/**
 * The entry point cli.ts uses: packaged builds only, warns instead of throwing. After an update it starts
 * the new executable with the same arguments in this terminal and exits with its exit code, so the new
 * version runs right away instead of the old one carrying on. If the new copy cannot be started, the old
 * one continues and says so. `seams` are for tests.
 */
export async function trySelfUpdate(
  version: string,
  cacheDir: string,
  seams: {
    isSea?: boolean;
    exe?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    update?: typeof selfUpdate;
    spawn?: typeof spawnSync;
    exit?: (code: number) => void;
  } = {},
): Promise<void> {
  if (version === 'dev' || !(seams.isSea ?? sea.isSea())) return;
  const exe = seams.exe ?? process.execPath;
  const env = seams.env ?? process.env;
  cleanupOld(exe);
  if (env[RELAUNCHED]) return; // we are the restarted copy, just updated
  let updated = false;
  try {
    updated = (await (seams.update ?? selfUpdate)({ version, exe, cacheDir })) === 'updated';
  } catch (e) {
    log.warn(`Could not check for a wow-forever-essentals-updater update: ${(e as Error)?.message ?? e}`);
  }
  if (!updated) return;

  log.info('Restarting with the new version...');
  const res = (seams.spawn ?? spawnSync)(exe, seams.args ?? process.argv.slice(2), { stdio: 'inherit', env: { ...env, [RELAUNCHED]: '1' } });
  if (res.error) {
    log.warn(`Could not restart automatically (${res.error.message}). Start it again to use the new version.`);
    return;
  }
  (seams.exit ?? process.exit)(res.status ?? 1);
}
