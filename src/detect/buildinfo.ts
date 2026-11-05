// Parses <WoW root>/.build.info: a pipe-separated table whose header names look
// like "Version!STRING:0". Columns are found by name because the order changes.

export interface BuildRow { product: string; version: string; active: boolean }

export function parseBuildInfo(text: string): BuildRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const cols = lines[0].split('|').map((c) => c.split('!')[0].trim().toLowerCase());
  const idx = (n: string) => cols.indexOf(n);
  const iProduct = idx('product'), iVersion = idx('version'), iActive = idx('active');
  if (iProduct < 0 || iVersion < 0) return [];
  return lines.slice(1).map((l) => {
    const f = l.split('|');
    return { product: f[iProduct] ?? '', version: f[iVersion] ?? '', active: iActive < 0 || f[iActive] === '1' };
  }).filter((r) => r.product);
}

// Known product codes and their client folders (warcraft.wiki.gg, WowUp constants).
// Forever currently ships as wow_classic_beta; its launch product is not known yet,
// which is why detection keys on the 1.60.x version and the folder is configurable.
export const PRODUCT_FOLDERS: Record<string, string> = {
  wow: '_retail_',
  wowt: '_ptr_',
  wowxptr: '_xptr_',
  wow_beta: '_beta_',
  wow_classic: '_classic_',
  wow_classic_ptr: '_classic_ptr_',
  wow_classic_beta: '_classic_beta_',
  wow_classic_titan: '_classic_titan_',
  wow_anniversary: '_anniversary_',
  wow_classic_era: '_classic_era_',
  wow_classic_era_ptr: '_classic_era_ptr_',
};

/** Folder for a product code; unknown codes follow the "wow_x" -> "_x_" pattern. */
export function folderForProduct(code: string): string {
  return PRODUCT_FOLDERS[code] ?? `_${code.replace(/^wow_?/, '') || 'retail'}_`;
}

/** Forever is game version 1.60.x. */
export function isForeverVersion(v: string | null | undefined): boolean {
  return !!v && /^1\.6\d\./.test(v);
}
