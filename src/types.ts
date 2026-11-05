// The seams every command goes through: Deps carries every side effect, Options the CLI flags.
import type { Source } from './sources/source.ts';
import type { Env } from './detect/detect.ts';

export interface Deps {
  source: Source;
  configDir: string;
  cacheDir: string;
  fetchImpl?: typeof fetch;
  env?: Env;
  runningWow?: () => string[];
  ask?: (question: string) => Promise<string>;
  tty?: boolean;
  /** desktop notification (the menu's refresh uses it); absent in tests */
  notify?: (title: string, body: string) => void;
}

export interface Options {
  addons?: string;
  yes?: boolean;
  force?: boolean;
  dryRun?: boolean;
  lang?: string;
  only?: string[];
  /** replace folders that look like a developer's working copy */
  overwriteDev?: boolean;
}
