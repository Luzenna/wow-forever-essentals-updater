// Routes each item to where it is released: the GitHub repo it declares, or its page on
// Wago Addons. One GitHubSource per repo, so each repo's release list is fetched once per run.
import { GitHubSource } from './github.ts';
import { WagoSource } from './wago.ts';
import { fixedRelease } from './fixed.ts';
import type { Source, Release } from './source.ts';
import type { Item } from '../catalog/catalog.ts';

export interface MultiSourceOptions {
  token?: string | null;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  retry?: any;
  wagoBase?: string;
}

export class MultiSource implements Source {
  name = 'GitHub';
  opts: MultiSourceOptions;
  sources: Map<string, GitHubSource>;
  wago: WagoSource;

  constructor(opts: MultiSourceOptions = {}) {
    this.opts = opts;
    this.sources = new Map();
    this.wago = new WagoSource({ base: opts.wagoBase, fetchImpl: opts.fetchImpl, retry: opts.retry });
  }

  invalidate(): void {
    for (const s of this.sources.values()) s.invalidate();
    this.wago.invalidate();
  }

  async latest(item: Item): Promise<Release | null> {
    if (item.url) return fixedRelease(item);
    if (item.wago) return this.wago.latest(item);
    const repo = item.repo ?? '';
    let s = this.sources.get(repo);
    if (!s) {
      s = new GitHubSource({ ...this.opts, repo });
      this.sources.set(repo, s);
    }
    return s.latest(item);
  }
}
