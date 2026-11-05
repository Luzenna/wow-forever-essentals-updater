// Test helpers: a tiny zip writer (stored, no compression), temp dirs and a
// local HTTP server that serves fake release zips.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * Build a zip in memory. Names are written verbatim, so tests can use
 * backslashes or "../" to exercise normalisation and zip-slip checks.
 * `files` maps name -> content (a name ending in "/" is a directory).
 */
export function makeZip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const fname = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fname.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fname.length, 28);
    central.writeUInt32LE(name.endsWith('/') ? 0x10 : 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fname, data);
    centrals.push(central, fname);
    offset += 30 + fname.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function tmpDir(prefix = 'spoken-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write a tree of files. */
export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

/** Every file under root with mtime and sha256, for "nothing changed" assertions. */
export function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        out[path.relative(root, p) + '/'] = String(fs.statSync(p).mtimeMs);
        walk(p);
      } else {
        out[path.relative(root, p)] = `${fs.statSync(p).mtimeMs}:${sha256(fs.readFileSync(p))}`;
      }
    }
  };
  walk(root);
  return out;
}

export const sha256 = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');

/** A .toc file body. */
export const toc = (version: string, iface = '11509, 20506, 16001', extra = ''): string =>
  `## Interface: ${iface}\n## Title: test\n## Version: ${version}\n${extra}`;

/**
 * Serve buffers over HTTP with Range support, counting requests.
 * `files` maps url path -> body.
 */
export async function serve(files: Record<string, Buffer>, opts: { failFirst?: number; ignoreRange?: boolean } = {}) {
  let failures = opts.failFirst ?? 0;
  const stats = { requests: 0, bytes: 0, ranges: [] as string[] };
  const server = http.createServer((req, res) => {
    stats.requests++;
    const body = files[req.url ?? ''];
    if (failures > 0) {
      failures--;
      res.writeHead(500).end();
      return;
    }
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    if (range && !opts.ignoreRange) {
      stats.ranges.push(req.headers.range ?? '');
      const start = Number(range[1]);
      const part = body.subarray(start);
      stats.bytes += part.length;
      res.writeHead(206, { 'Content-Length': part.length, 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}` });
      res.end(part);
      return;
    }
    stats.bytes += body.length;
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    stats,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
