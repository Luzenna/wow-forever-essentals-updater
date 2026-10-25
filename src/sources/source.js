// @ts-check
// The contract every release source implements. GitHub is the only one today;
// a Wago source (needs a personal API key) can be added as another file.

/**
 * @typedef {object} Asset
 * @property {string} name
 * @property {string} url       direct download URL
 * @property {number} size      bytes
 * @property {string | null} sha256  lowercase hex, when the source publishes a digest
 */

/**
 * @typedef {object} Release
 * @property {string} version   clean semver, e.g. "2.2.1" (or "1.0.5-f" for letter-suffixed builds)
 * @property {string} tag       e.g. "quests-audio/v2.2.1" or "v1.4.1"
 * @property {Asset} asset
 * @property {string} [notes]  the release notes (markdown), when the source has them
 * @property {string} source    source name, for status output
 */

/**
 * @typedef {object} Source
 * @property {string} name
 * @property {(item: import('../catalog.js').Item) => Promise<Release | null>} latest
 *   Latest stable release for the item, or null when the source has none.
 */

export {};
