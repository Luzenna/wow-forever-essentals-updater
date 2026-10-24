// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as semver from '../src/semver.js';
import { parseToc, tocOwner } from '../src/toc.js';

test('semver compares numerically, not as strings or by date', () => {
  assert.equal(semver.compare('2.10.0', '2.9.9'), 1);
  assert.equal(semver.compare('v2.2.1', '2.2.1'), 0);
  assert.equal(semver.compare('0.0.3', '0.0.10'), -1);
  assert.equal(semver.compare('2.0.0', '0.0.3'), 1);
  assert.equal(semver.compare('1.0.0-beta.2', '1.0.0'), -1);
  assert.equal(semver.compare('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(semver.compare('1.0.0-alpha', '1.0.0-1'), 1);
});

test('semver max skips invalid versions', () => {
  assert.equal(semver.max(['2.1.0', 'banana', '2.10.0', '2.2.0', 'v3']), '2.10.0');
  assert.equal(semver.max(['nope']), null);
  assert.equal(semver.clean('v2.3.2'), '2.3.2');
  assert.equal(semver.valid('2.3'), false);
});

test('toc parsing reads version, interface list and X-Part-Of', () => {
  const t = parseToc('﻿## Interface: 100007, 16001\r\n## Title: x\r\n## Version: 2.3.2\r\n## X-Part-Of: Spoken\r\nfile.lua\r\n');
  assert.equal(t.version, '2.3.2');
  assert.deepEqual(t.interfaces, [100007, 16001]);
  assert.equal(t.partOf, 'Spoken');
  assert.deepEqual(parseToc('## Interface: 11509').interfaces, [11509]);
});

test('toc owner handles flavor suffixes', () => {
  assert.equal(tocOwner('SpokenPlayer.toc'), 'SpokenPlayer');
  assert.equal(tocOwner('SpokenPlayer_Mainline.toc'), 'SpokenPlayer');
  assert.equal(tocOwner('SpokenPlayer-Forever.toc'), 'SpokenPlayer');
  assert.equal(tocOwner('SpokenPlayer_Camelot.toc'), 'SpokenPlayer');
  assert.equal(tocOwner('SpokenQuestsAudio_frFR.toc'), 'SpokenQuestsAudio_frFR');
  assert.equal(tocOwner('readme.md'), null);
});

test('WoW process detection matches game clients only', async () => {
  const { WOW_EXE, linuxProcesses } = await import('../src/platform.js');
  for (const n of ['Wow.exe', 'WowB.exe', 'WowClassic.exe', 'WowClassicB.exe', 'WOWB.EXE']) assert.ok(WOW_EXE.test(n), n);
  for (const n of ['WowVoiceProxy.exe', 'WowVoiceProxyT.exe', 'World of Warcraft Launcher.exe', 'Battle.net.exe', 'wowup.exe.bak']) {
    assert.ok(!WOW_EXE.test(n), n);
  }
  // A fake /proc: wine runs the client with its Windows path in cmdline.
  const { tmpDir, writeTree } = await import('./helpers.js');
  const proc = tmpDir();
  writeTree(proc, {
    // comm is truncated to 15 chars by the kernel, so cmdline is what identifies the client.
    '101/cmdline': 'C:\\Program Files (x86)\\World of Warcraft\\_classic_beta_\\WowB.exe\0-launch\0', '101/comm': 'WowB.exe',
    '102/cmdline': 'C:\\windows\\system32\\WowVoiceProxyT.exe\0', '102/comm': 'WowVoiceProxyT.',
    '104/cmdline': 'Z:\\home\\deck\\Games\\World of Warcraft\\_classic_beta_\\WowClassicB.exe\0', '104/comm': 'WowClassicB.exe',
    '103/cmdline': '/usr/bin/konsole\0', '103/comm': 'konsole',
  });
  assert.deepEqual(linuxProcesses(proc).sort(), ['WowB.exe', 'WowClassicB.exe']);
});

test('semver letter suffixes are later builds only when asked', () => {
  const L = { letters: true };
  assert.equal(semver.compare('1.0.5-b', '1.0.5', L), 1);
  assert.equal(semver.compare('1.0.5-f', '1.0.5-b', L), 1);
  assert.equal(semver.compare('1.0.6', '1.0.5-f', L), 1);
  assert.equal(semver.compare('1.0.5-rc1', '1.0.5', L), -1, 'a real prerelease stays one');
  assert.equal(semver.compare('1.0.5-b', '1.0.5'), -1, 'default: -b is a prerelease');
  assert.equal(semver.clean('v1.0.5-f', L), '1.0.5-f');
});
