# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`wow-forever-essentals-updater` (formerly `spoken-updater`): a Node 22+ ESM CLI (no TypeScript, but JSDoc with `// @ts-check`) that installs and updates a chosen set of addons for WoW: Forever on Windows and Steam Deck (Linux): Spoken (addon + voice packs), LuzennaForever, NodeSight and Dialogue UI. With no command in a terminal it opens an interactive menu. It ships as Node single-executable binaries. See `README.md` for user-facing behaviour, flags, config and release rules.

## Commands

```
npm install
npm start                      # run from source (node src/main.js); e.g. npm start -- status --dry-run
npm test                       # node --test "test/*.test.js" — no network
node --test test/app.test.js   # one test file
node --test --test-name-pattern="<regex>" test/app.test.js   # one test
npm run build                  # dist/wow-forever-essentals-updater.exe + dist/wow-forever-essentals-updater-linux-x64
node scripts/build.mjs win-x64 # or linux-x64 (also `make windows` / `make linux`)
```

There is no linter. The build downloads and sha256-verifies the official Node binaries into `build/` (gitignored) and injects an esbuild bundle (`build/bundle.cjs`, entry `src/main.js`) with postject. To try the real CLI without touching your config, set `WFE_UPDATER_HOME` to a temp dir and pass `--addons <temp dir>`.

## Architecture

- `src/main.js` is the process entry (runs `main()`, maps errors to exit codes, `--pause-on-exit`); `src/cli.js` exports `main(argv, test?)` (parseArgs, wiring, command switch) with no side effects on import, so tests call it with `{ interactive, deps, io }` seams. With no command it runs the menu when interactive and not `--yes`/`--dry-run`, otherwise `update`.
- `src/ui.js` is the look: colour on/off (`NO_COLOR`, `FORCE_COLOR`, TTY), Unicode vs ASCII symbols (`WFE_ASCII`), banner, `truncate`/`pad` that ignore colour codes. `src/log.js` has the output helpers; `log.scoped(id, title)` prints a titled block on a terminal and `[id] ...` lines when redirected. Anything redrawn in place must go through `truncate`, or wrapped lines break the cursor-up redraw.
- `src/menu.js` is the menu loop (update, select addons, status, settings); `src/tui.js` has the `choose`/`checklist` prompts: arrow keys via readline keypress events on a raw-mode TTY, numbered line input through `io.ask` otherwise.
- `src/app.js` is the update engine (`inspect` -> plan -> download -> extract -> swap). **All side effects go through the `Deps` object** (`source`, `fetchImpl`, `env`, `runningWow`, `ask`, `configDir`, `cacheDir`), which is how tests run the whole flow against fake servers and fake AddOns trees. Keep new I/O behind `deps`.
- `src/addons.js` holds the built-in single-folder addons as data (`BUILTIN`: repo, folders, title); `src/custom.js` loads/validates/edits the user's `addons.json` (same shape, never throws on bad input, refuses `Blizzard_*` and folders another addon owns) and parses repo addresses. `src/catalog.js` turns both, plus Spoken (the one multi-item special case), into `Item`s: `listGroups(custom)` is what the menu selects, `buildCatalog({ selected, custom, pinned, ... })` returns the items. An `Item` carries its `repo`, `tagMode` (`prefix` for Spoken's `<prefix>/<version>` tags, `plain` for `vX.Y.Z`), `owns(folder)`, optional `letterSuffix`, `assetPattern` (regex picking the zip) and `pin`. **`owns` is the safety rule**: an item may only write or remove folders it owns (Spoken: `/^spoken/i`; every other addon, built-in or custom: its declared `folders`). Item ids (`spoken`, `quests-audio`, `luzenna-forever`, custom ids...) are state keys, cache keys and `--only` names, so keep them stable. Spoken's `replaces` lists retired 2.x items/folders that must be removed in the same transaction as the 3.x install or lines are voiced twice.
- `src/addrepo.js` is the add-from-GitHub flow (menu and `add` command): probe the latest release, download the zip into the normal cache, list its addon folders with `zipAddonFolders` (central directory only), confirm, write `addons.json` and `selected`. `uninstall()` in `app.js` is the remove flow: it moves the state-recorded folders through `swapIn({ roots: [], remove })`, so backup, rollback and the in-use-folder fallback come for free. `devCopyReason` (`platform.js`) marks links and `.git` folders as developer copies that `inspect`, `installItem` and `uninstall` leave alone unless `--overwrite-dev`. `src/notes.js` boils release notes down for the "what's new" lines.
- `src/sources/`: `source.js` is the `Source` interface; `github.js` implements it for one repo (newest stable by semver, multi-flavor zip, sha256 digest check); `multi.js` routes each item to a `GitHubSource` for its `item.repo`. `semver.js` has an opt-in `{ letters: true }` mode where `1.0.5-f` is a later build of `1.0.5` (Dialogue UI's rebuild tags), not a prerelease.
- `src/detect/` finds the AddOns folder: Battle.net `product.db` (`productdb.js`), build info, registry, common folders, and on Linux Proton/Lutris/Heroic/Bottles/wine prefixes; `fold.js` does case-insensitive path lookups (Linux/Wine).
- `src/download.js` (resume with Range, retry/backoff, cache), `src/extract.js` (yauzl; path normalisation and zip-slip refusal; Spoken placeholder detection), `src/swap.js` (rename-based swap with backup, rollback and a crash-recovery journal; a folder another program is working in, which Windows won't rename, is emptied into the backup and refilled in place; also looks for a journal under the old `.spoken-updater` work dir), `src/lock.js`, `src/platform.js` (free space, running-WoW check), `src/config.js` (config.json with `selected`, state.json, one-time `migrateLegacy` copy from the old `spoken-updater` dir), `src/selfupdate.js` (replaces the executable from this tool's own GitHub releases).
- The `.toc` of each installed folder (`src/toc.js`) is the source of truth for installed version; `state.json` only supplies folder names and the size baseline. When a `.toc` Version doesn't match the release tag, `inspect` falls back to "same tag as recorded in state means current".

## Tests

`node:test` in `test/`. `test/helpers.js` provides an in-memory stored-zip writer (`makeZip`, which writes names verbatim so tests can use backslashes or `../`), temp dirs, and a local HTTP server serving fake release zips. `test/app.test.js` covers Spoken end to end, `test/addons.test.js` the plain-tag addons and migration, `test/custom.test.js` addons.json, adding/removing, developer copies, pins and notes, `test/menu.test.js` the prompts, the menu loop and the entry rules (a `PassThrough` stands in for the keyboard), `test/ui.test.js` colours, widths and the dashboard rows. Add tests in this style rather than touching the network.

## Releases

Pushes to `main` touching `src/`, `scripts/` or `package*.json` auto-release via `.github/workflows/release.yml`. The version bump is driven by commit subject markers: `#minor`/`[minor]`, `#major`/`[major]`, `#norelease`, `#release` (default is patch). Mind these markers when writing commit messages. Releases publish only the `wow-forever-essentals-updater` binaries (the old `spoken-updater`-named copies were dropped once the existing installs had updated; releases up to v1.1.1 still carry them). `SELF_REPO` in `src/selfupdate.js` must match the real GitHub repo name.
