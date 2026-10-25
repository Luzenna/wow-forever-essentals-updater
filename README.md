# wow-forever-essentals-updater

Installs and updates the essential addons for **World of Warcraft: Forever** (1.60.x, Interface 16001), on Windows 10/11 and the Steam Deck. Pick the addons you want in a menu, then install or update them in one go.

| Addon | What it is | Source |
|---|---|---|
| **Spoken** | voiceover for quests, zones and books (addon plus audio packs, about 2.3 GB) | [rusty-key/spoken-wow](https://github.com/rusty-key/spoken-wow) |
| **LuzennaForever** | one-bag tweaks, alt inventory tracking, error log | [Luzenna/wowaddon-LuzennaForever](https://github.com/Luzenna/wowaddon-LuzennaForever) |
| **NodeSight** | herb and ore names on the minimap | [Krelock/NodeSight](https://github.com/Krelock/NodeSight) |
| **Dialogue UI** | quest and gossip dialogue window | [Peterodox/YUI-Dialogue](https://github.com/Peterodox/YUI-Dialogue) |

It downloads only what changed. If everything is already current, it downloads nothing and changes no files.

## Use

Run it with no arguments in a terminal and a menu opens. It starts with a short overview of your addons, in plain words:

```
╔════════════════════════════════════════════════════════════╗
║ WoW Forever  ·  Essentials Updater                  v1.1.1 ║
╚════════════════════════════════════════════════════════════╝

Your addons ────────────────────────────────────────────────

  ●  Spoken          3.5.1     up to date
  ●  LuzennaForever  0.1.0     update available → 1.0.0  14.0 KB to download
  ●  NodeSight       ·         not installed  48.0 KB to download
  ○  Dialogue UI               not selected

What would you like to do?

  ► Install or update my addons    3 to install or update, 2.5 GB
    Choose which addons I want
    Add or remove addons...
    See what's installed
    Settings
    Quit
```

- **Install or update my addons** downloads only what changed, shows a progress bar per addon, and ends with a summary of what was updated and what failed.
- **Choose which addons I want** is a checkbox list (arrows and Space, `a` for all/none, Enter to confirm, Esc to cancel). Choosing Spoken also asks whether to include the Zone and Book voices. Your choice is saved in the config, and addons you don't select are never touched.
- **Add or remove addons...** adds any GitHub repo that publishes a release zip (see [Your own addons](#your-own-addons)), or uninstalls an addon.
- **See what's installed** shows versions, status and download sizes in detail.
- **Settings** sets the WoW AddOns folder (when several installs exist) and the Spoken voice language.
- Without a keyboard-capable terminal the same lists take numbers instead.
- Colour and symbols are used on a real terminal only. Redirected output, `NO_COLOR=1` and scripts get plain text. Set `WFE_ASCII=1` for plain symbols if boxes or arrows show as `?` in your console.

All four addons are selected by default. Commands skip the menu:

```
wow-forever-essentals-updater                     menu (or, with --yes / no terminal, update)
wow-forever-essentals-updater update              install or update the selected addons
wow-forever-essentals-updater status              installed vs latest for every item
wow-forever-essentals-updater update --dry-run    show what would happen
wow-forever-essentals-updater install --only nodesight
wow-forever-essentals-updater add owner/name       add an addon from GitHub (see Your own addons)
wow-forever-essentals-updater remove --only nodesight   uninstall an addon (settings are kept)
wow-forever-essentals-updater detect              list the AddOns folders found
wow-forever-essentals-updater clean               prune the download cache
wow-forever-essentals-updater --lang frFR         also install the French Spoken voice packs
```

From source (needs Node 22+): `npm install`, then `npm start`.

**Spoken items by default:**
- the Spoken addon: the player plus its Quests, Zones and Books modules (folders `Spoken`, `Spoken_Quests`, `Spoken_Zones`, `Spoken_Books`, `SpokenContributions`)
- the voice packs Spoken Quests Audio (the "All" bundle), Spoken Zones Audio and Spoken Books Audio

**Item ids** (for `--only`): `spoken`, `quests-audio`, `zones-audio`, `books-audio`, `luzenna-forever`, `nodesight`, `dialogueui`, and the id of any addon you added yourself. `remove --only` takes addon ids (`spoken` removes the addon and all its voice packs). With a language set you also get `quests-audio-<lang>`, `zones-audio-<lang>` and `books-audio-<lang>`. `--only` can name an item you haven't selected.

**Flags:**
- `--addons <path>`: use this AddOns folder.
- `--yes`: never prompt (and skip the menu).
- `--force`: install even while WoW is running.
- `--pin <version>`: with `install --only <item>`, install that exact version and hold it there. This also rolls back a bad update. `--unpin` releases the hold. Status shows "held at 1.4.0".
- `--overwrite-dev`: replace (or remove) a folder that looks like your own working copy; see below.
- `--no-self-update`: skip the check for a newer version of this tool. Normally `update`, `install` and the menu first look at this tool's GitHub releases and, if a newer one exists, download it (sha256-checked, and test-run before use) and replace the executable; the new version takes effect on the next run. If anything fails it only prints a warning and carries on.
- `--pause-on-exit`: keep the window open at the end.
- `--verbose`: print more detail.

**Exit codes:** 0 ok, 1 an item failed, 2 usage/detection problem or WoW running.

### Steam Deck

1. Switch to Desktop Mode and copy `wow-forever-essentals-updater-linux-x64` to your home folder, e.g. `~/wfe-updater`.
2. Run `chmod +x ~/wfe-updater` in Konsole, then `~/wfe-updater`.
3. Optional: in Steam, choose *Add a Non-Steam Game*, pick the file, and set its launch options to `--yes --pause-on-exit` (this installs or updates what you selected, with no menu).

The tool searches for your WoW install under:
- Proton prefixes, in `~/.local/share/Steam/steamapps/compatdata` and Steam libraries on the SD card under `/run/media`
- Lutris (`~/Games`), Heroic (`~/Games/Heroic/Prefixes`), Bottles and `~/.wine`

### Windows

Run `wow-forever-essentals-updater.exe` in a terminal, or double-click it. The tool finds WoW through Battle.net's `product.db`, the Battle.net config, the registry, and the common install folders.

## Config

- **Windows:** `%APPDATA%\wow-forever-essentals-updater\config.json`. The cache is in `%LOCALAPPDATA%\wow-forever-essentals-updater\cache`.
- **Linux:** `~/.config/wow-forever-essentals-updater/config.json`. The cache is in `~/.cache/wow-forever-essentals-updater`.

The first run copies `config.json` and `state.json` from the old `spoken-updater` folder, if there is one, so nothing needs redoing.

```json
{
  "addons_path": "",
  "client_folder": "_forever_",
  "language": "enUS",
  "include_zones": true,
  "include_books": true,
  "github_token": "",
  "keep_downloads": false,
  "selected": ["spoken", "luzenna-forever", "nodesight", "dialogueui"],
  "pinned": {}
}
```

- `selected`: the addons to install and keep updated, including the ids of addons you added. The menu edits this.
- `addons_path`: overrides detection. If several WoW installs are found, the one in the `_forever_` client folder is used automatically. If more than one install has a `_forever_` folder, the tool asks once (Enter takes the first) and saves your choice here.
- `client_folder`: the Forever client folder. Change it if Blizzard renames the folder at launch. Clients that report game version 1.60.x are detected regardless of folder name.
- `include_zones` / `include_books`: the Spoken Zones and Books modules and their voice packs.
- `github_token`: optional, only needed if you hit GitHub's rate limit of 60 requests an hour (one request per addon repo per run). Takes `WFE_GITHUB_TOKEN` or `GITHUB_TOKEN` from the environment too (`SPOKEN_GITHUB_TOKEN` still works).
- `pinned`: addon item ids held at a version, e.g. `{ "nodesight": "1.4.0" }`. `install --only <id> --pin <version>` writes it.
- `keep_downloads`: keep zips after a successful install. By default they are deleted to save space, but kept after a failure so a retry doesn't download them again.

`state.json`, next to the config, records what was installed. Each folder's `.toc` is the source of truth. An item is reinstalled if:
- its folder or `.toc` disappears, or
- its file count or size changes by more than 10%.

An addon you installed by hand is recognised by its folder name and updated in place.

## Your own addons

Any GitHub repo whose releases include a `.zip` of the addon folder can be added.

- **From the menu:** *Add or remove addons...* > *Add an addon from GitHub*, then paste the repo address (`owner/name` or a github.com link). The tool looks at the latest release, reads which folders its zip would install, shows them, and asks before saving. Or from the command line: `add owner/name`.
- **By hand:** edit `addons.json` in the config folder (next to `config.json`). It is plain JSON, so you can copy it to another computer or share it:

```json
{
  "addons": [
    {
      "repo": "owner/name",
      "folders": ["MyAddon", "MyAddon_Options"],
      "title": "My Addon",
      "id": "myaddon",
      "blurb": "what it does",
      "asset": "retail",
      "letter_suffix": false
    }
  ]
}
```

`repo` and `folders` are required. `id` defaults to the repo name in lower case, `title` to the repo name. `asset` is an optional pattern that picks the zip when a release has several (for example one per game version). `letter_suffix` is for authors who number rebuilds `1.0.5`, `1.0.5-b`, `1.0.5-c`. A hand-added addon shows up unticked in *Choose which addons I want*.

How it is kept safe:
- An addon may only write the folders listed in `folders`. Anything else in its zip is ignored.
- `Blizzard_*` folders, and folders that Spoken or another addon already manages, are refused.
- A mistake in the file never stops the tool: a broken entry is skipped with a message, and unreadable JSON is reported and left untouched.
- Adding an addon means trusting its author. Only add addons from people you trust.

Limits: plain `vX.Y.Z` release tags only, and the repo needs a GitHub release with a zip (not just tags or a branch). CurseForge and Wago are not supported.

**Removing** an addon deletes the folders this tool installed for it (after asking), stops it being selected and, for an addon you added, takes it out of `addons.json`. Your settings in `WTF/` are kept, so reinstalling brings them back.

**What's new:** when an update is available, the release notes' first few lines are shown before it installs.

**Developer copies:** a folder that is a link to another folder, or has a `.git` folder inside, is treated as your own work in progress. It is shown as "developer copy" and never replaced or removed, unless you pass `--overwrite-dev`. A plain folder you edit in place is not detected: untick that addon in the menu while you work on it.

## Where things come from

Everything comes from GitHub Releases, one repo per addon.

**Spoken** uses one tag prefix per item:

| Item | Tag prefix |
|---|---|
| `spoken` | `spoken/` (one zip: `Spoken-<version>.zip`) |
| `quests-audio` | `quests-audio/` |
| `zones-audio` | `zones-audio/` |
| `books-audio` | `books-audio/` |
| language packs | e.g. `quests-audio-frFR/` |

**LuzennaForever, NodeSight and Dialogue UI** use plain tags (`v1.4.1`) and one zip each (`NodeSight-1.4.1.zip`). Dialogue UI also publishes rebuilds as `v1.0.5-b`, `v1.0.5-c` ...; those count as later builds of 1.0.5, not as prereleases.

**How the version and file are chosen:**
- The newest stable version is picked by semver.
- The multi-flavor zip is used, not the `-WoW_1.12`-style legacy builds.
- Each download is checked against GitHub's sha256 digest.

**Not offered (Spoken):**
- The old faction-split quest packs stopped at v2.0.0 and don't support Forever.
- There is no 64 kbps zones pack.

**Spoken 3.x.** Since 3.0.0 the player and the Quests, Zones and Books modules ship as one
addon. The old 2.x folders (`SpokenPlayer`, `SpokenQuests`, `SpokenZones`, `SpokenBooks`) are
retired, and the `quests/`, `zones/` and `books/` tags are no longer used. Installing 3.x
removes those old folders in the same transaction; otherwise both generations would load and
every line would be voiced twice. Upstream's empty placeholder folders (e.g. the new
`SpokenPlayer`, "now Spoken") are never installed.

Sources plug in through `src/sources/source.js`. A Wago source is possible, but Wago's API needs a personal API key.

## How it installs safely

1. **WoW must be closed.** The tool refuses to run while `Wow*.exe` is running, including under Wine/Proton, unless you pass `--force`.
2. **Disk space is checked first**, for both the download cache and the AddOns drive.
3. **Downloads resume and retry.** They resume with HTTP Range and retry with backoff.
4. **Zips are unpacked into `Interface/.wow-forever-essentals-updater`**, on the same drive as AddOns. Paths are normalised (backslashes, wrapper folders, double nesting) and unsafe paths are refused.
5. **Each addon only writes its own folders.** Spoken writes folders named `Spoken*`; LuzennaForever, NodeSight and Dialogue UI write `LuzennaForever`, `NodeSight` and `DialogueUI`. Everything else in the zip is ignored, and other addons and `WTF/` are never touched. The Spoken zips also contain `VoiceOverRedux` and `ZoneLore`. These are empty placeholders named after the addons' old names, only useful for carrying over settings from those old addons, so they are not installed.
6. **Folders are swapped in by renaming.** Old folders move to a backup and new ones move in. If anything fails, everything is moved back. A journal lets the next run finish or undo a swap that was interrupted by a crash (including one left by the old `spoken-updater` name).
7. **A folder that is in use is replaced in place.** Windows refuses to rename a folder while any program is working inside it (a terminal or editor opened in that folder). In that case the folder's contents are moved to the backup and the new files are moved into the same folder, with the same rollback on failure. If a file inside is itself held open, nothing is changed and the message says which folder to free up.

## Development

```
npm test           # node:test, no network, fake zips and fake WoW/Steam Deck trees
npm run build      # dist/wow-forever-essentals-updater.exe and dist/wow-forever-essentals-updater-linux-x64
make               # same, via make
```

The build bundles `src/` with esbuild into a Node [single executable application](https://nodejs.org/api/single-executable-applications.html). It downloads the official Node binaries for each platform, checks them against nodejs.org's SHASUMS256, and injects the bundle. Both targets build from Windows or Linux. Each binary is about 85–120 MB because it contains Node.

Console look and feel lives in `src/ui.js` (colours, symbols, banner) and `src/tui.js` (the lists); it all falls back to plain text off a terminal.

To make an addon built in, add it to `BUILTIN` in `src/addons.js`; Spoken, which is several items, is the only special case, in `src/catalog.js`.

## Releases

Every push to `main` that touches `src/`, `scripts/` or `package*.json` is released by
`.github/workflows/release.yml`. It runs the tests on Ubuntu and Windows, builds both
executables, smoke-tests each on its own OS, and publishes a GitHub release with
`SHA256SUMS.txt`.

The version comes from the latest `vX.Y.Z` tag, bumped by the subject lines of the pushed commits:

| In a commit subject | Effect |
|---|---|
| (nothing) | patch: 0.1.0 -> 0.1.1 |
| `#minor` or `[minor]` | minor: 0.1.1 -> 0.2.0 |
| `#major` or `[major]` | major: 0.2.0 -> 1.0.0 |
| `#norelease` | skip releasing this push |
| `#release` | release even if only docs/CI changed |

The first release uses the version in `package.json`. You can also start a release by hand from the Actions tab.
