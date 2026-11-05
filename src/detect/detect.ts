// Finds candidate AddOns folders for the Forever client on Windows and on Linux
// (Steam Deck: Proton prefixes, Lutris, Heroic, Bottles, plain Wine).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseProductDb } from './productdb.ts';
import { parseBuildInfo, folderForProduct, isForeverVersion } from './buildinfo.ts';
import { findChild, resolveFold } from '../disk/fold.ts';

/** Everything platform-specific, so tests can point detection at fake trees. */
export interface Env {
  platform: 'win32' | 'linux';
  home: string;
  /** Windows drive roots, e.g. ["C:\\", "D:\\"] */
  drives: string[];
  /** Windows %APPDATA% */
  appData: string | null;
  /** Linux removable media root (/run/media) */
  runMedia: string;
  /** Windows uninstall-key InstallLocation values */
  registryInstallDirs: () => string[];
}

export interface Candidate {
  /** the AddOns folder (may not exist yet) */
  addons: string;
  /** whether the AddOns folder exists */
  exists: boolean;
  /** e.g. .../World of Warcraft/_classic_beta_ */
  clientDir: string;
  /** where it was found */
  label: string;
  /** game version when known */
  version: string | null;
  /** confirmed Forever (1.60.x) by product.db or .build.info */
  forever: boolean;
}

/** The client folder the Forever launcher creates. It is always looked at, whatever client_folder says. */
export const FOREVER_FOLDER = '_forever_';

/** Whether a candidate is in the _forever_ client folder. */
export const isForeverFolder = (c: Candidate) => path.basename(c.clientDir).toLowerCase() === FOREVER_FOLDER;

export function realEnv(): Env {
  const platform = process.platform === 'win32' ? 'win32' : 'linux';
  const drives: string[] = [];
  if (platform === 'win32') {
    for (let c = 67; c <= 90; c++) {
      const d = String.fromCharCode(c) + ':\\';
      if (fs.existsSync(d)) drives.push(d);
    }
  }
  return {
    platform,
    home: os.homedir(),
    drives,
    appData: process.env.APPDATA ?? null,
    runMedia: '/run/media',
    registryInstallDirs: platform === 'win32' ? registryInstallDirs : () => [],
  };
}

/** InstallLocation of every uninstall entry whose data mentions World of Warcraft. */
function registryInstallDirs(): string[] {
  const out: string[] = [];
  for (const key of [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]) {
    try {
      const txt = execFileSync('reg', ['query', key, '/s', '/f', 'World of Warcraft', '/d'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const sub of txt.split(/\r?\n/).filter((l) => l.startsWith('HKEY_'))) {
        try {
          const v = execFileSync('reg', ['query', sub, '/v', 'InstallLocation'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
          const m = /InstallLocation\s+REG_\w+\s+(.+)/.exec(v);
          if (m) out.push(m[1].trim());
        } catch { /* no InstallLocation */ }
      }
    } catch { /* key missing or reg unavailable */ }
  }
  return out;
}

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Identity of a path for de-duplication: symlinks resolved (on SteamOS
 * ~/.steam/steam points at ~/.local/share/Steam), case folded only on Windows.
 */
const realKey = (p: string) => {
  let r = path.resolve(p);
  try {
    r = fs.realpathSync(r);
  } catch { /* doesn't exist (yet) */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

const subdirs = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
};

const readText = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

function readProducts(file: string) {
  try {
    return parseProductDb(fs.readFileSync(file));
  } catch {
    return [];
  }
}

/** A WoW root plus what we know about its clients (folder -> version). */
interface Root { root: string; label: string; clients: Map<string, string | null> }

/**
 * Map a Windows path from product.db (e.g. "C:/Program Files (x86)/World of Warcraft")
 * into a Wine prefix: C: is drive_c, other letters go through dosdevices symlinks.
 */
export function winePath(prefix: string, winPath: string) {
  const m = /^([a-zA-Z]):[\\/]*(.*)$/.exec(winPath);
  if (!m) return null;
  const base = m[1].toLowerCase() === 'c' ? path.join(prefix, 'drive_c') : path.join(prefix, 'dosdevices', `${m[1].toLowerCase()}:`);
  return resolveFold(base, m[2]).path;
}

/** Steam library folders: the default ones plus those listed in libraryfolders.vdf. */
function steamLibraries(env: Env) {
  const roots = [
    path.join(env.home, '.local/share/Steam'),
    path.join(env.home, '.steam/steam'),
    path.join(env.home, '.var/app/com.valvesoftware.Steam/.local/share/Steam'),
    path.join(env.home, '.var/app/com.valvesoftware.Steam/data/Steam'),
  ];
  const libs = new Set(roots.filter(isDir));
  for (const r of [...libs]) {
    for (const vdf of ['steamapps/libraryfolders.vdf', 'config/libraryfolders.vdf']) {
      const txt = readText(path.join(r, vdf));
      if (!txt) continue;
      for (const m of txt.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'));
    }
  }
  // SD cards and USB drives: /run/media/<label> (old SteamOS) or /run/media/<user>/<label>.
  for (const a of subdirs(env.runMedia)) {
    libs.add(a);
    for (const b of subdirs(a)) libs.add(b);
  }
  const unique = new Map<string, string>();
  for (const l of libs) if (isDir(path.join(l, 'steamapps')) && !unique.has(realKey(l))) unique.set(realKey(l), l);
  return [...unique.values()];
}

/** Wine prefixes (dirs containing drive_c) with a human label. */
export function winePrefixes(env: Env) {
  const out: { prefix: string; label: string }[] = [];
  for (const lib of steamLibraries(env)) {
    const where = lib.startsWith(env.runMedia) ? ` on ${lib}` : '';
    for (const app of subdirs(path.join(lib, 'steamapps/compatdata'))) {
      out.push({ prefix: path.join(app, 'pfx'), label: `Steam/Proton app ${path.basename(app)}${where}` });
    }
  }
  const gameDirs = new Set([path.join(env.home, 'Games')]);
  for (const yml of ['.config/lutris/system.yml', '.var/app/net.lutris.Lutris/config/lutris/system.yml']) {
    const m = /^\s*game_path:\s*(.+?)\s*$/m.exec(readText(path.join(env.home, yml)) ?? '');
    if (m) gameDirs.add(m[1].replace(/^~(?=\/|$)/, env.home).replace(/^['"]|['"]$/g, ''));
  }
  for (const g of gameDirs) for (const d of subdirs(g)) out.push({ prefix: d, label: `Lutris ${path.basename(d)}` });
  const heroic = path.join(env.home, 'Games/Heroic/Prefixes');
  for (const d of [...subdirs(heroic), ...subdirs(path.join(heroic, 'default'))]) out.push({ prefix: d, label: `Heroic ${path.basename(d)}` });
  for (const b of [path.join(env.home, '.local/share/bottles/bottles'), path.join(env.home, '.var/app/com.usebottles.bottles/data/bottles/bottles')]) {
    for (const d of subdirs(b)) out.push({ prefix: d, label: `Bottles ${path.basename(d)}` });
  }
  out.push({ prefix: path.join(env.home, '.wine'), label: 'Wine ~/.wine' });
  return out.filter((p) => isDir(path.join(p.prefix, 'drive_c')));
}

/** All plausible WoW roots, de-duplicated. */
function findRoots(env: Env): Root[] {
  const roots = new Map<string, Root>();
  const add = (dir: string | null, label: string, client?: { folder: string | null; version: string | null }) => {
    if (!dir || !isDir(dir)) return;
    const key = realKey(dir);
    if (!roots.has(key)) roots.set(key, { root: path.resolve(dir), label, clients: new Map() });
    if (client?.folder) (roots.get(key) as Root).clients.set(client.folder, client.version);
  };
  const fromProductDb = (dbFile: string, mapLoc: (loc: string) => string | null, label: string) => {
    for (const p of readProducts(dbFile)) {
      if (!p.location || !p.code.startsWith('wow')) continue;
      add(mapLoc(p.location), label, { folder: p.folder || folderForProduct(p.code), version: p.version });
    }
  };

  if (env.platform === 'win32') {
    for (const d of env.drives) {
      fromProductDb(path.join(d, 'ProgramData/Battle.net/Agent/product.db'), (l) => path.normalize(l), 'Battle.net');
    }
    if (env.appData) {
      try {
        const cfg = JSON.parse(readText(path.join(env.appData, 'Battle.net/Battle.net.config')) ?? '{}');
        const def = cfg?.Client?.Install?.DefaultInstallPath;
        if (def) add(path.join(def, 'World of Warcraft'), 'Battle.net default path');
      } catch { /* unreadable config */ }
    }
    for (const d of env.registryInstallDirs()) add(d, 'Windows registry');
    for (const d of env.drives) {
      for (const rel of ['Program Files (x86)/World of Warcraft', 'Program Files/World of Warcraft', 'World of Warcraft', 'Games/World of Warcraft']) {
        add(path.join(d, rel), 'common location');
      }
    }
  } else {
    for (const { prefix, label } of winePrefixes(env)) {
      const db = resolveFold(prefix, 'drive_c/ProgramData/Battle.net/Agent/product.db');
      if (db.exists) fromProductDb(db.path, (l) => winePath(prefix, l), label);
      for (const rel of ['Program Files (x86)/World of Warcraft', 'Program Files/World of Warcraft']) {
        const r = resolveFold(prefix, 'drive_c', rel);
        if (r.exists) add(r.path, label);
      }
    }
  }

  // .build.info confirms versions for products the root has installed.
  for (const r of roots.values()) {
    const bi = findChild(r.root, '.build.info');
    for (const row of bi ? parseBuildInfo(readText(path.join(r.root, bi)) ?? '') : []) {
      if (!row.active) continue;
      const folder = folderForProduct(row.product);
      if (!r.clients.get(folder)) r.clients.set(folder, row.version);
    }
  }
  return [...roots.values()];
}

/**
 * Candidate AddOns folders: Forever-confirmed ones first, and within those the _forever_ client folder.
 */
export function detect(opts: { clientFolder: string }, env: Env = realEnv()): Candidate[] {
  const out = new Map<string, Candidate>();
  for (const r of findRoots(env)) {
    const folders = new Map([...r.clients].filter(([, v]) => isForeverVersion(v)));
    // _forever_ is always tried, and so is the configured client folder, so a renamed
    // launch folder works without a new release of this tool.
    for (const f of [FOREVER_FOLDER, opts.clientFolder]) if (!folders.has(f)) folders.set(f, r.clients.get(f) ?? null);
    for (const [folder, version] of folders) {
      const client = resolveFold(r.root, folder);
      if (!client.exists) continue;
      const addons = resolveFold(client.path, 'Interface', 'AddOns');
      const key = realKey(addons.path);
      if (out.has(key)) continue;
      out.set(key, { addons: addons.path, exists: addons.exists, clientDir: client.path, label: r.label, version, forever: isForeverVersion(version) });
    }
  }
  return [...out.values()].sort((a, b) => Number(b.forever) - Number(a.forever) || Number(isForeverFolder(b)) - Number(isForeverFolder(a)));
}
