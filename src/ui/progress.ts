// Download progress: an ASCII bar redrawn in place on a terminal, or a line every
// 10% when output is redirected (e.g. launched from a Steam shortcut with a log).
import { bytes } from './log.ts';
import { colorOn, paint, sym } from './term.ts';

/**
 */
export function createProgress(label: string, total: number, opts: { tty?: boolean; write?: (s: string) => void; now?: () => number } = {}) {
  const tty = opts.tty ?? !!process.stdout.isTTY;
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const now = opts.now ?? Date.now;
  const start = now();
  let startBytes = -1;
  let lastDraw = 0;
  let lastStep = -1;

  const line = (done: number) => {
    const pct = total ? Math.min(100, Math.floor((done / total) * 100)) : 0;
    const width = 30;
    const fill = Math.round((pct / 100) * width);
    const secs = Math.max(0.001, (now() - start) / 1000);
    const rate = (done - Math.max(0, startBytes)) / secs;
    if (colorOn()) {
      const s = sym();
      return `  ${paint('green', s.bar.repeat(fill))}${paint('dim', s.barOff.repeat(width - fill))} ${paint('bold', String(pct).padStart(3) + '%')}  ${bytes(done)} / ${bytes(total)}  ${paint('dim', bytes(Math.round(rate)) + '/s')}`;
    }
    return `  [${'#'.repeat(fill)}${'-'.repeat(width - fill)}] ${String(pct).padStart(3)}%  ${bytes(done)} / ${bytes(total)}  ${bytes(Math.round(rate))}/s`;
  };

  return {
    /** `done`: bytes so far, including any resumed part. */
    update(done: number) {
      if (startBytes < 0) startBytes = done;
      if (tty) {
        if (now() - lastDraw < 200 && done < total) return;
        lastDraw = now();
        write('\r' + line(done) + '  ');
      } else if (total >= 50e6) {
        // Redirected output: a line per 10%, and only for downloads big enough to wait on.
        const step = total ? Math.floor((done / total) * 10) : 0;
        if (step > lastStep && step > 0) {
          lastStep = step;
          write(`  ${label}: ${step * 10}% (${bytes(done)} / ${bytes(total)})\n`);
        }
      }
    },
    finish(done: number) {
      if (tty) write('\r' + line(done) + '  \n');
      else if (total >= 50e6 && lastStep < 10) write(`  ${label}: 100% (${bytes(done)})\n`);
    },
  };
}
