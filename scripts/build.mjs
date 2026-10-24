// Cross-builds single-file executables for windows-x64 and linux-x64 from any OS,
// using Node's Single Executable Applications:
//   1. esbuild bundles src/ + yauzl into one CommonJS file
//   2. node --experimental-sea-config turns it into a blob (no code cache or
//      snapshot, so the blob is portable across platforms)
//   3. the official node binary of the same version is downloaded for each target,
//      checked against nodejs.org's SHASUMS256.txt, and the blob is injected into it
// Output: dist/wow-forever-essentals-updater.exe and dist/wow-forever-essentals-updater-linux-x64
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { inject } from 'postject';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = path.join(root, 'build');
const dist = path.join(root, 'dist');
const NODE = process.version; // the blob format must match the runtime it's injected into
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const TARGETS = [
  { name: 'win-x64', archive: `node-${NODE}-win-x64.zip`, member: `node-${NODE}-win-x64/node.exe`, out: 'wow-forever-essentals-updater.exe' },
  { name: 'linux-x64', archive: `node-${NODE}-linux-x64.tar.gz`, member: `node-${NODE}-linux-x64/bin/node`, out: 'wow-forever-essentals-updater-linux-x64' },
];

const only = process.argv.slice(2);
fs.mkdirSync(build, { recursive: true });
fs.mkdirSync(dist, { recursive: true });

// 1. Bundle
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
await esbuild.build({
  entryPoints: [path.join(root, 'src/main.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(build, 'bundle.cjs'),
  banner: { js: `// wow-forever-essentals-updater ${pkg.version}` },
  define: { 'globalThis.__APP_VERSION__': JSON.stringify(pkg.version) },
  logLevel: 'warning',
});

// 2. SEA blob
const seaConfig = path.join(build, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: path.join(build, 'bundle.cjs'),
  output: path.join(build, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
const blob = fs.readFileSync(path.join(build, 'sea-prep.blob'));

// 3. Node binaries
async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

let shasums;
async function nodeArchive(file) {
  const cached = path.join(build, 'node', file);
  if (!fs.existsSync(cached)) {
    console.log(`downloading ${file}`);
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached + '.tmp', await get(`https://nodejs.org/dist/${NODE}/${file}`));
    fs.renameSync(cached + '.tmp', cached);
  }
  shasums ??= (await get(`https://nodejs.org/dist/${NODE}/SHASUMS256.txt`)).toString();
  const want = new RegExp(`^([0-9a-f]{64})\\s+${file.replace(/\./g, '\\.')}$`, 'm').exec(shasums)?.[1];
  const got = crypto.createHash('sha256').update(fs.readFileSync(cached)).digest('hex');
  if (!want || want !== got) {
    fs.rmSync(cached);
    throw new Error(`checksum mismatch for ${file}`);
  }
  return fs.readFileSync(cached);
}

/** One file out of a .tar.gz (ustar, with GNU/pax long names). */
function fromTarGz(buf, member) {
  const tar = zlib.gunzipSync(buf);
  let longName = null;
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156]);
    const name = longName ?? (str(345, 500) ? `${str(345, 500)}/${str(0, 100)}` : str(0, 100));
    longName = null;
    const data = tar.subarray(off + 512, off + 512 + size);
    if (type === 'L') longName = data.toString('utf8').replace(/\0.*$/s, '');
    else if (type === 'x') longName = /\d+ path=(.*)\n/.exec(data.toString('utf8'))?.[1] ?? null;
    else if (name === member) return Buffer.from(data);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${member} not found in archive`);
}

/** One file out of a .zip, via the central directory. */
function fromZip(buf, member) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    if (name === member) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      return method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    }
    p += 46 + nlen + elen + clen;
  }
  throw new Error(`${member} not found in archive`);
}

// 4. Inject
for (const t of TARGETS) {
  if (only.length && !only.includes(t.name)) continue;
  const archive = await nodeArchive(t.archive);
  const exe = t.archive.endsWith('.zip') ? fromZip(archive, t.member) : fromTarGz(archive, t.member);
  const out = path.join(dist, t.out);
  fs.writeFileSync(out, exe);
  await inject(out, 'NODE_SEA_BLOB', blob, { sentinelFuse: FUSE });
  fs.chmodSync(out, 0o755);
  console.log(`built ${path.relative(root, out)} (${(fs.statSync(out).size / 1e6).toFixed(0)} MB, node ${NODE})`);
}
