// @ts-check
// Routes each item to the GitHub repo it declares. One GitHubSource per repo, so
// each repo's release list is fetched once per run.
import { GitHubSource } from './github.js';

export class MultiSource {
  name = 'GitHub';

  /** @param {{ token?: string | null, apiBase?: string, fetchImpl?: typeof fetch, retry?: any }} [opts] */
  constructor(opts = {}) {
    this.opts = opts;
    /** @type {Map<string, GitHubSource>} */
    this.sources = new Map();
  }

  /** @param {import('../catalog.js').Item} item @returns {Promise<import('./source.js').Release | null>} */
  latest(item) {
    let s = this.sources.get(item.repo);
    if (!s) {
      s = new GitHubSource({ ...this.opts, repo: item.repo });
      this.sources.set(item.repo, s);
    }
    return s.latest(item);
  }
}
