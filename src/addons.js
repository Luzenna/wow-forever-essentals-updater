// @ts-check
// The addons built into the tool, as data. Spoken is special (several items, its own
// tag convention) and lives in catalog.js; everything here is a single-folder addon
// released on plain vX.Y.Z tags, the same shape a user can add in addons.json.

/**
 * @typedef {object} AddonEntry
 * @property {string} id
 * @property {string} title
 * @property {string} blurb
 * @property {string} [repo]         GitHub "owner/name" (unset for an addon that comes from Wago)
 * @property {string} [wago]         Wago Addons slug ("baganator" in addons.wago.io/addons/baganator), instead of a repo
 * @property {string[]} folders      the AddOns folders this addon owns, and the only ones it may write
 * @property {boolean} [letterSuffix] tags like 1.0.5-f are later builds of 1.0.5, not prereleases
 * @property {string} [asset]        regex that picks the zip when a release has several
 * @property {boolean} [custom]      comes from addons.json
 * @property {string[]} [requires]   ids of addons this one does not work without; they are installed with it
 * @property {boolean} [optIn]       not selected on a fresh config; the user has to pick it
 */

export const SPOKEN = {
  id: 'spoken', title: 'Spoken', blurb: 'voiceover for quests, zones and books (about 2.3 GB of audio)', repo: 'rusty-key/spoken-wow',
};

/** @type {AddonEntry[]} */
export const BUILTIN = [
  { id: 'luzenna-forever', title: 'LuzennaForever', blurb: 'one-bag tweaks, alt inventory tracking, error log', repo: 'Luzenna/wowaddon-LuzennaForever', folders: ['LuzennaForever'] },
  { id: 'nodesight', title: 'NodeSight', blurb: 'herb and ore names on the minimap', repo: 'Krelock/NodeSight', folders: ['NodeSight'] },
  { id: 'dialogueui', title: 'Dialogue UI', blurb: 'quest and gossip dialogue window', repo: 'Peterodox/YUI-Dialogue', folders: ['DialogueUI'], letterSuffix: true },
  // Optional extras: off until picked. The first one is on GitHub; the rest are only released on Wago Addons.
  { id: 'dialogkey', title: 'DialogKey', blurb: 'space bar accepts quests and gossip options', repo: 'NumyAddon/DialogKey_Numy', folders: ['DialogKey_Numy'], optIn: true },
  { id: 'syndicator', title: 'Syndicator', blurb: 'item data across your characters (Baganator needs it)', wago: 'syndicator', folders: ['Syndicator'], optIn: true },
  { id: 'baganator', title: 'Baganator', blurb: 'bags and bank, one window or by category', wago: 'baganator', folders: ['Baganator'], requires: ['syndicator'], optIn: true },
  { id: 'auctionator', title: 'Auctionator', blurb: 'a faster, friendlier auction house', wago: 'auctionator', folders: ['Auctionator'], optIn: true },
  { id: 'journalator', title: 'Journalator', blurb: 'auction, crafting, quest and loot statistics (works with Auctionator)', wago: 'journalator', folders: ['Journalator', 'Journalator_Display', 'Journalator_OptionsUI', 'Journalator_Statistics'], optIn: true },
  { id: 'chattynator', title: 'Chattynator', blurb: 'chat window replacement', wago: 'chattynator', folders: ['Chattynator'], optIn: true },
  { id: 'platynator', title: 'Platynator', blurb: 'configurable nameplates', wago: 'platynator', folders: ['Platynator'], optIn: true },
];

/** Group ids that are always known: Spoken plus the built-in addons. */
export const BUILTIN_IDS = [SPOKEN.id, ...BUILTIN.map((a) => a.id)];
/** What a fresh config selects: everything except the opt-in extras. */
export const DEFAULT_SELECTED = [SPOKEN.id, ...BUILTIN.filter((a) => !a.optIn).map((a) => a.id)];
