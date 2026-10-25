// @ts-check
// GitHub Releases source. Lists every release once per run (paginated), then
// answers per-item queries by tag prefix and semver.
import * as semver from '../semver.js';
import { HttpError, USER_AGENT, withRetry } from '../http.js';

/**
 * @typedef {{ name: string, size: number, browser_download_url: string, digest?: string | null, state?: string }} GhAsset
 * @typedef {{ tag_name: string, draft: boolean, prerelease: boolean, assets: GhAsset[], body?: string | null }} GhRelease
 */

/**
 * Zips meant for Blizzard clients: legacy private-server builds ("<Addon>-WoW_1.12-<ver>.zip") excluded.
 * An item's own pattern narrows it further (e.g. only the retail build of a multi-flavor release).
 * @param {GhAsset[]} assets @param {RegExp} [pattern]
 */
const usableZips = (assets, pattern) =>
  assets.filter((a) => /\.zip$/i.test(a.name) && !/-WoW_\d/i.test(a.name) && (a.state ?? 'uploaded') === 'uploaded' && (!pattern || pattern.test(a.name)));

/**
 * Pick the zip meant for modern clients (which includes Forever). Usually there
 * is exactly one. When there are several (spoken/v3.0.0 shipped Spoken-3.0.0.zip
 * plus tiny placeholder zips for the retired addons), prefer the one named after
 * the tag prefix, e.g. "spoken" -> "Spoken-3.0.0.zip", and otherwise the largest.
 * @param {GhAsset[]} assets @param {string} [prefix] @param {string | null} [version] @param {RegExp} [pattern] @returns {GhAsset}
 */
export function pickAsset(assets, prefix, version, pattern) {
  const zips = usableZips(assets, pattern);
  if (zips.length === 1) return zips[0];
  if (!zips.length) {
    const why = pattern ? ` matching /${pattern.source}/` : '';
    throw new Error(`no Forever-compatible zip${why} among assets: ${assets.map((a) => a.name).join(', ') || '(none)'}`);
  }
  const named = prefix && version
    ? zips.filter((a) => a.name.toLowerCase() === `${prefix}-${version}.zip`.toLowerCase() || a.name.toLowerCase() === `${prefix}-v${version}.zip`.toLowerCase())
    : [];
  if (named.length === 1) return named[0];
  return [...zips].sort((x, y) => y.size - x.size)[0];
}

/**
 * Releases for one tag prefix (or, with `plain`, every release whose whole tag is a
 * version), newest first by semver. Drafts, prereleases and tags that aren't a
 * version are dropped. `letters` reads 1.0.5-f as a later build of 1.0.5.
 * @param {GhRelease[]} releases @param {string | null} prefix
 * @param {{ plain?: boolean, letters?: boolean }} [mode]
 */
export function filterReleases(releases, prefix, mode = {}) {
  const want = mode.plain ? '' : prefix + '/';
  const o = { letters: !!mode.letters };
  return releases
    .filter((r) => !r.draft && !r.prerelease && r.tag_name.startsWith(want))
    .map((r) => ({ r, version: semver.clean(r.tag_name.slice(want.length), o) }))
    .filter((x) => x.version !== null && !semver.parse(x.version, o)?.pre.length)
    .sort((a, b) => semver.compare(/** @type {string} */ (b.version), /** @type {string} */ (a.version), o));
}

/** @param {string | null} link */
function nextLink(link) {
  const m = link && /<([^>]+)>;\s*rel="next"/.exec(link);
  return m ? m[1] : null;
}

export class GitHubSource {
  name = 'GitHub';

  /**
   * @param {{ repo?: string, token?: string | null, apiBase?: string, fetchImpl?: typeof fetch, retry?: Parameters<typeof withRetry>[1] }} [opts]
   */
  constructor(opts = {}) {
    this.repo = opts.repo ?? '';
    this.token = opts.token ?? null;
    this.apiBase = opts.apiBase ?? 'https://api.github.com';
    this.fetch = opts.fetchImpl ?? fetch;
    this.retry = opts.retry;
    /** @type {Promise<GhRelease[]> | null} */
    this.cache = null;
    /** @type {Promise<GhRelease[]> | null} */
    this.recentCache = null;
  }

  /** Every release, paginated. @returns {Promise<GhRelease[]>} */
  releases() {
    // A failure must not stick: the menu keeps this source for the whole session.
    this.cache ??= this.#fetch(100, true).catch((e) => {
      this.cache = null;
      throw e;
    });
    return this.cache;
  }

  /** Just the newest releases, one small request. Plain-tag repos only need these. @returns {Promise<GhRelease[]>} */
  recent() {
    this.recentCache ??= this.#fetch(30, false).catch((e) => {
      this.recentCache = null;
      throw e;
    });
    return this.recentCache;
  }

  /** @param {number} perPage @param {boolean} allPages */
  async #fetch(perPage, allPages) {
    /** @type {GhRelease[]} */
    const all = [];
    /** @type {string | null} */
    let url = `${this.apiBase}/repos/${this.repo}/releases?per_page=${perPage}`;
    while (url) {
      const page = /** @type {string} */ (url);
      const res = await withRetry(async () => {
        /** @type {Record<string, string>} */
        const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': USER_AGENT };
        // The token only ever goes to the API host.
        if (this.token && new URL(page).host === new URL(this.apiBase).host) headers.Authorization = `Bearer ${this.token}`;
        const r = await this.fetch(page, { headers });
        if (!r.ok) {
          if (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0' && !this.token) {
            throw Object.assign(new HttpError(page, r.status, r.headers), {
              message: 'GitHub API rate limit reached. Set WFE_GITHUB_TOKEN (or github_token in config) and try again.',
            });
          }
          if (r.status === 404) {
            throw Object.assign(new HttpError(page, r.status, r.headers), { message: `${this.repo} was not found on GitHub (or it is private)` });
          }
          throw new HttpError(page, r.status, r.headers);
        }
        return r;
      }, this.retry);
      all.push(.../** @type {GhRelease[]} */ (await res.json()));
      url = allPages ? nextLink(res.headers.get('link')) : null;
    }
    return all;
  }

  /** @param {import('../catalog.js').Item} item @returns {Promise<import('./source.js').Release | null>} */
  async latest(item) {
    const o = { letters: !!item.letterSuffix };
    const mode = { plain: item.tagMode === 'plain', letters: item.letterSuffix };
    /** @param {GhRelease[]} list */
    const pick = (list) => {
      const found = filterReleases(list, item.tagPrefix ?? null, mode);
      if (!item.pin) return found;
      const want = semver.clean(item.pin, o);
      return found.filter((x) => want !== null && semver.compare(/** @type {string} */ (x.version), want, o) === 0);
    };
    // Plain-tag repos: the newest page is enough; look at everything only when it holds nothing usable.
    const hasZip = (/** @type {ReturnType<typeof pick>} */ l) => l.some((x) => usableZips(x.r.assets, item.assetPattern).length);
    let releases = mode.plain ? pick(await this.recent()) : pick(await this.releases());
    if (mode.plain && !hasZip(releases)) releases = pick(await this.releases());
    if (!releases.length) {
      if (item.pin) throw new Error(`version ${item.pin} was not found in ${this.repo}'s releases`);
      return null;
    }
    const stem = item.assetPrefix ?? item.tagPrefix;
    // A release can be published without assets (spoken/v3.0.1 was); fall back
    // to the newest one that has a usable zip.
    const top = releases.find((x) => usableZips(x.r.assets, item.assetPattern).length);
    if (!top) pickAsset(releases[0].r.assets, stem, releases[0].version, item.assetPattern); // throws a clear error
    const t = /** @type {typeof releases[number]} */ (top);
    const a = pickAsset(t.r.assets, stem, /** @type {string} */ (t.version), item.assetPattern);
    const digest = a.digest && /^sha256:([0-9a-f]{64})$/i.exec(a.digest);
    return {
      version: /** @type {string} */ (t.version),
      tag: t.r.tag_name,
      asset: { name: a.name, url: a.browser_download_url, size: a.size, sha256: digest ? digest[1].toLowerCase() : null },
      notes: t.r.body ?? '',
      source: this.name,
    };
  }
}
