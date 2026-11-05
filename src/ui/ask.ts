import readline from 'node:readline/promises';
import type { Deps } from '../types.ts';

/** One line of input from the terminal, or deps.ask when a test supplies it. */
export function makeAsk(deps: Deps): (question: string) => Promise<string> {
  return deps.ask ?? (async (q: string) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Without this, Ctrl+C only pauses stdin: the question never settles and the process exits silently with 0.
    rl.on('SIGINT', () => {
      rl.close();
      process.exit(130);
    });
    try {
      return await rl.question(q);
    } finally {
      rl.close();
    }
  });
}
