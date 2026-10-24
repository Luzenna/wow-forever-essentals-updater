#!/usr/bin/env node
// @ts-check
// Process entry point (the esbuild/SEA bundle starts here). cli.js holds the logic
// and has no side effects on import, so tests can call main() directly.
import * as log from './log.js';
import { UsageError } from './app.js';
import { main } from './cli.js';

/** Keep the console window open briefly (Steam shortcut / double-click). */
async function pause() {
  if (!process.stdin.isTTY) {
    // No keyboard to press Enter on (e.g. a Steam shortcut): just keep the window up.
    await new Promise((r) => setTimeout(r, 30_000));
    return;
  }
  process.stdout.write('\nPress Enter to close (closes by itself in 30 s)...');
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 30_000);
    process.stdin.once('data', () => (clearTimeout(t), resolve(undefined)));
    process.stdin.resume();
  });
  process.stdin.pause();
}

// No top-level await: the single-executable build bundles this file as CommonJS.
async function run() {
  const argv = process.argv.slice(2);
  let code;
  try {
    code = await main(argv);
  } catch (e) {
    if (e instanceof UsageError || /** @type {any} */ (e)?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      log.error(/** @type {Error} */ (e).message);
      code = 2;
    } else {
      log.error(/** @type {Error} */ (e)?.message ?? String(e));
      if (argv.includes('--verbose') || argv.includes('-v')) console.error(e);
      code = 1;
    }
  }
  if (argv.includes('--pause-on-exit')) await pause();
  process.exitCode = code ?? 0;
}

run();
