// @ts-check
// Routes each item to where it is released: the GitHub repo it declares, or its page on
// Wago Addons. One GitHubSource per repo, so each repo's release list is fetched once per run.
import { GitHubSource } from './github.js';
import { WagoSource } from './wago.js';
import { fixedRelease } from './fixed.js';

export class MultiSource {
  name = 'GitHub';

  /** @param {{ token?: string | null, apiBase?: string, fetchImpl?: typeof fetch, retry?: any, wagoBase?: string }} [opts] */
  constructor(opts = {}) {
    this.opts = opts;
    /** @type {Map<string, GitHubSource>} */
    this.sources = new Map();
    this.wago = new WagoSource({ base: opts.wagoBase, fetchImpl: opts.fetchImpl, retry: opts.retry });
  }

  /** @param {import('../catalog.js').Item} item @returns {Promise<import('./source.js').Release | null>} */
  async latest(item) {
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
