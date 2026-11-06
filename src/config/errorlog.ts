// A small log of failed checks (errors.log in the config folder), so "couldn't check for updates"
// can be explained after the fact. Best effort: logging must never break a run.
import fs from 'node:fs';
import path from 'node:path';

export const ERROR_LOG = 'errors.log';
const MAX_BYTES = 128 * 1024;

/** The message of an error with the underlying cause appended (fetch failures hide it there). */
export function describeError(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  const base = err?.message ?? String(e);
  const cause = err?.cause?.code ?? err?.cause?.message;
  return cause && !base.includes(cause) ? `${base} (${cause})` : base;
}

export function logError(configDir: string, what: string, e: unknown): void {
  try {
    const file = path.join(configDir, ERROR_LOG);
    fs.mkdirSync(configDir, { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) {
        const keep = fs.readFileSync(file, 'utf8').slice(-MAX_BYTES / 2);
        fs.writeFileSync(file, keep.slice(keep.indexOf('\n') + 1));
      }
    } catch {
      // no log yet
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${what}: ${describeError(e).replace(/\s+/g, ' ')}\n`);
  } catch {
    // a log that cannot be written is not worth an error
  }
}
