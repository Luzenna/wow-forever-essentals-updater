// The seams every command goes through: Deps carries every side effect, Options the CLI flags.
import type { Source } from './sources/source.ts';
import type { Env } from './detect/detect.ts';

/** check: the newer version of this tool on GitHub, or null. apply: download it, swap it in and restart into it (returns only if that did not happen). */
export interface SelfUpdater {
  check(): Promise<string | null>;
  apply(): Promise<void>;
}

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
  /** this tool's own updates, for the menu's timer; only in the packaged executable */
  selfUpdate?: SelfUpdater;
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
