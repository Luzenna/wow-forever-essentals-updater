// @ts-check
// Free disk space and "is WoW running?" for Windows and Linux.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** The nearest existing ancestor of a path (the path itself if it exists). @param {string} p */
export function existingAncestor(p) {
  let cur = path.resolve(p);
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return cur;
}

/** Bytes available to us on the filesystem holding `p`. @param {string} p */
export function freeBytes(p) {
  const s = fs.statfsSync(existingAncestor(p));
  return s.bavail * s.bsize;
}

/** Device id, to tell whether two paths share a filesystem. @param {string} p */
export function deviceOf(p) {
  return fs.statSync(existingAncestor(p)).dev;
}

// WoW client executables: Wow.exe, WowB.exe, WowClassic.exe, WowClassicB.exe ...
// The Battle.net launcher ("World of Warcraft Launcher.exe") deliberately doesn't
// match, and neither does the voice-chat helper (WowVoiceProxy.exe, WowVoiceProxyT.exe),
// which can outlive the game.
export const WOW_EXE = /^wow(?!voiceproxy)\w*\.exe$/i;

/** @param {string} arg */
const baseName = (arg) => arg.split(/[\\/]/).pop() ?? '';

/** Names of running WoW client processes. @returns {string[]} */
export function runningWow() {
  return process.platform === 'win32' ? windowsProcesses() : linuxProcesses();
}

function windowsProcesses() {
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map((l) => /^"([^"]+)"/.exec(l)?.[1] ?? '').filter((n) => WOW_EXE.test(n));
  } catch {
    return [];
  }
}

/** Scans /proc: under Wine/Proton the exe shows up in cmdline (and often comm). @param {string} [proc] */
export function linuxProcesses(proc = '/proc') {
  const found = new Set();
  let pids;
  try {
    pids = fs.readdirSync(proc).filter((d) => /^\d+$/.test(d));
  } catch {
    return [];
  }
  for (const pid of pids) {
    try {
      const args = fs.readFileSync(path.join(proc, pid, 'cmdline'), 'utf8').split('\0').filter(Boolean);
      for (const a of args.slice(0, 3)) if (WOW_EXE.test(baseName(a))) found.add(baseName(a));
      const comm = fs.readFileSync(path.join(proc, pid, 'comm'), 'utf8').trim();
      if (WOW_EXE.test(comm)) found.add(comm);
    } catch {
      // process exited or isn't ours to read
    }
  }
  return [...found];
}

/**
 * Whether an addon folder looks like someone's work in progress: a link (the usual way to
 * develop an addon from a repo checkout) or a folder with its own .git. Returns why, or null.
 * @param {string} addons @param {string} name  folder name inside AddOns
 */
export function devCopyReason(addons, name) {
  const dir = path.join(addons, name);
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return 'is a link to another folder';
  } catch {
    return null; // not there
  }
  return fs.existsSync(path.join(dir, '.git')) ? 'has a .git folder' : null;
}
