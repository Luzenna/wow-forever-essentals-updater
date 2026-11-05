// Wago Addons source, for addons that are only released there. Wago has no public
// download API (its documented API is for uploading releases and needs a key), so this
// reads what the public addon page itself carries: the page embeds, as JSON in its
// data-page attribute, the newest release per game flavour with a download link. We take
// the "forever" flavour, follow the link once (a HEAD request) to learn the zip's real
// address and size, and hand that to the normal downloader.
//
// This depends on the shape of Wago's page, so every step fails with a message that says
// which part changed instead of guessing.
import * as semver from '../semver.ts';
import { HttpError, USER_AGENT, withRetry } from '../net/http.ts';
import type { Item } from '../catalog/catalog.ts';
import type { Release } from './source.ts';

const FLAVOR = 'forever';

export interface WagoRelease {
  label?: string;
  changelog?: string;
  download_link?: string;
}

/** The text of an HTML attribute value, with the five entities a server escapes. */
const unescapeAttr = (s: string): string => s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * The release for one game flavour out of an addon page, or null when the addon has none for it.
 * Throws when the page is not the shape we know.
 */
export function parseAddonPage(html: string, flavor: string = FLAVOR): WagoRelease | null {
  const m = /\sdata-page="([^"]*)"/.exec(html);
  if (!m) throw new Error('the page has no data-page block (Wago may have changed its site)');
  let page: any;
  try {
    page = JSON.parse(unescapeAttr(m[1]));
  } catch {
    throw new Error('the page data is not valid JSON (Wago may have changed its site)');
  }
  const releases = page?.props?.metadata?.recent_releases;
  if (releases === undefined) throw new Error('the page data has no release list (Wago may have changed its site)');
  // PHP sends an addon without releases as [] rather than {}.
  const r = releases && !Array.isArray(releases) ? releases[flavor] : null;
  return r && typeof r === 'object' ? r : null;
}

/** Wago changelogs are generated: drop the "[Full Changelog](...)" link line. */
const cleanNotes = (text: string | undefined): string => String(text ?? '').replace(/\r/g, '').split('\n').filter((l) => !/^\s*\[?full changelog\b/i.test(l)).join('\n');

export class WagoSource {
  name = 'Wago';
  base: string;
  fetch: typeof fetch;
  retry: Parameters<typeof withRetry>[1];
  pages: Map<string, Promise<WagoRelease | null>>;

  constructor(opts: { base?: string; fetchImpl?: typeof fetch; retry?: Parameters<typeof withRetry>[1] } = {}) {
    this.base = (opts.base ?? 'https://addons.wago.io').replace(/\/+$/, '');
    this.fetch = opts.fetchImpl ?? fetch;
    this.retry = opts.retry;
    this.pages = new Map();
  }

  /** One page request per addon per run, shared by whatever asks. A failure must not stick. */
  #release(slug: string): Promise<WagoRelease | null> {
    let p = this.pages.get(slug);
    if (!p) {
      p = this.#fetchPage(slug).catch((e) => {
        this.pages.delete(slug);
        throw e;
      });
      this.pages.set(slug, p);
    }
    return p;
  }

  async #fetchPage(slug: string): Promise<WagoRelease | null> {
    const url = `${this.base}/addons/${encodeURIComponent(slug)}`;
    const res = await withRetry(async () => {
      const r = await this.fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' } });
      if (r.status === 404) throw Object.assign(new HttpError(url, 404, r.headers), { message: `"${slug}" was not found on Wago Addons` });
      if (!r.ok) throw new HttpError(url, r.status, r.headers);
      return r;
    }, this.retry);
    try {
      return parseAddonPage(await res.text());
    } catch (e) {
      throw new Error(`${slug} on Wago: ${(e as Error).message}`);
    }
  }

  async latest(item: Item): Promise<Release | null> {
    const slug = item.wago;
    if (!slug) throw new Error(`${item.id} has no Wago slug`);
    const r = await this.#release(slug);
    if (!r?.label || !r.download_link) return null;

    // "v1.2.62" -> 1.2.62, and "13.16.2-forever" -> 13.16.2 (the flavor name is not part of the version the .toc carries).
    const clean = (s: string) => s.trim().replace(/^v(?=\d)/i, '').replace(/-forever$/i, '');
    const version = clean(r.label);
    if (!semver.valid(version, { loose: true })) throw new Error(`${slug} on Wago: version "${r.label}" is not a version number`);
    // Wago's page only ever offers the newest release.
    if (item.pin && semver.compare(clean(item.pin), version, { loose: true }) !== 0) {
      throw new Error(`Wago only offers the newest ${slug} (${version}), so ${item.pin} cannot be pinned`);
    }

    // The link must stay on Wago; it is only ever followed from here.
    const link = new URL(r.download_link, this.base);
    if (link.origin !== new URL(this.base).origin) throw new Error(`${slug} on Wago: download link points to ${link.origin}`);
    const head = await withRetry(async () => {
      const h = await this.fetch(link, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': USER_AGENT } });
      if (!h.ok) throw new HttpError(link.href, h.status, h.headers);
      return h;
    }, this.retry);
    const size = Number(head.headers.get('content-length'));
    if (!Number.isFinite(size) || size <= 0) throw new Error(`${slug} on Wago: the download does not say how big it is`);
    // The address the link redirects to is a plain file URL that does not expire.
    const file = new URL(head.url || link.href);
    const name = decodeURIComponent(file.pathname.split('/').pop() ?? '');
    return {
      version,
      tag: r.label.trim(),
      asset: { name: /\.zip$/i.test(name) ? name : `${slug}-${version}.zip`, url: file.href, size, sha256: null },
      notes: cleanNotes(r.changelog),
      source: this.name,
    };
  }
}
