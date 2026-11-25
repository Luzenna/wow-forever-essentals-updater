// Ask the console window to open bigger. A console app cannot set pixels, only a size in character
// cells (120x40 is roughly 1000x800 pixels at the default font). The old Windows console honours the
// xterm "resize" escape sequence; Windows Terminal ignores it (its size is the user's own setting),
// and so does everything else, so it is only sent on Windows, in the old console, never to shrink.

export const WANT_COLUMNS = 120;
export const WANT_ROWS = 40;

/** The escape sequence to send, or '' when the window should be left alone. */
export function growSequence(
  size: { columns?: number; rows?: number },
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): string {
  if (platform !== 'win32' || env.WT_SESSION || env.WFE_NO_RESIZE) return '';
  const columns = Math.max(size.columns || 0, WANT_COLUMNS);
  const rows = Math.max(size.rows || 0, WANT_ROWS);
  if (columns === size.columns && rows === size.rows) return '';
  return `\x1b[8;${rows};${columns}t`;
}

export function growWindow(out: NodeJS.WriteStream = process.stdout, input: NodeJS.ReadStream = process.stdin) {
  if (!out.isTTY || !input.isTTY) return;
  const seq = growSequence(out);
  if (seq) out.write(seq);
}
