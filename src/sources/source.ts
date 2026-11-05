// The contract every release source implements: GitHub (github.ts) and Wago Addons
// (wago.ts, for addons that are not released on GitHub). multi.ts picks one per item.
import type { Item } from '../catalog/catalog.ts';

export interface Asset {
  name: string;
  /** direct download URL */
  url: string;
  /** bytes */
  size: number;
  /** lowercase hex, when the source publishes a digest */
  sha256: string | null;
}

export interface Release {
  /** clean semver, e.g. "2.2.1" (or "1.0.5-f" for letter-suffixed builds) */
  version: string;
  /** e.g. "quests-audio/v2.2.1" or "v1.4.1" */
  tag: string;
  asset: Asset;
  /** the release notes (markdown), when the source has them */
  notes?: string;
  /** source name, for status output */
  source: string;
}

export interface Source {
  name?: string;
  /** Latest stable release for the item, or null when the source has none. */
  latest(item: Item): Promise<Release | null>;
}
