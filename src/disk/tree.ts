import fs from 'node:fs';
import path from 'node:path';

/** File count and total size of a folder tree. */
export function treeStats(dir: string): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  const walk = (d: string): void => {
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
