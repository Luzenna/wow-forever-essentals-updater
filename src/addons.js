// @ts-check
// The addons built into the tool, as data. Spoken is special (several items, its own
// tag convention) and lives in catalog.js; everything here is a single-folder addon
// released on plain vX.Y.Z tags, the same shape a user can add in addons.json.

/**
 * @typedef {object} AddonEntry
 * @property {string} id
 * @property {string} title
 * @property {string} blurb
 * @property {string} repo           GitHub "owner/name"
 * @property {string[]} folders      the AddOns folders this addon owns, and the only ones it may write
 * @property {boolean} [letterSuffix] tags like 1.0.5-f are later builds of 1.0.5, not prereleases
 * @property {string} [asset]        regex that picks the zip when a release has several
 * @property {boolean} [custom]      comes from addons.json
 */

export const SPOKEN = {
  id: 'spoken', title: 'Spoken', blurb: 'voiceover for quests, zones and books (about 2.3 GB of audio)', repo: 'rusty-key/spoken-wow',
};

/** @type {AddonEntry[]} */
export const BUILTIN = [
  { id: 'luzenna-forever', title: 'LuzennaForever', blurb: 'one-bag tweaks, alt inventory tracking, error log', repo: 'Luzenna/wowaddon-LuzennaForever', folders: ['LuzennaForever'] },
  { id: 'nodesight', title: 'NodeSight', blurb: 'herb and ore names on the minimap', repo: 'Krelock/NodeSight', folders: ['NodeSight'] },
  { id: 'dialogueui', title: 'Dialogue UI', blurb: 'quest and gossip dialogue window', repo: 'Peterodox/YUI-Dialogue', folders: ['DialogueUI'], letterSuffix: true },
];

/** Group ids that are always known: Spoken plus the built-in addons. */
export const BUILTIN_IDS = [SPOKEN.id, ...BUILTIN.map((a) => a.id)];
