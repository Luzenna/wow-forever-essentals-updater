# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`wow-forever-essentals-updater` (formerly `spoken-updater`): a Node 24+ ESM CLI written in TypeScript (run directly by Node's type stripping, type-checked with `tsc --noEmit`, bundled by esbuild) that installs and updates a chosen set of addons for WoW: Forever on Windows and Steam Deck (Linux): Spoken (addon + voice packs), LuzennaForever, NodeSight and Dialogue UI. With no command in a terminal it opens an interactive menu. It ships as Node single-executable binaries. See `README.md` for user-facing behaviour, flags, config and release rules.

## Commands

```
npm install
npm start                      # run from source (node src/main.ts); e.g. npm start -- status --dry-run
npm run typecheck              # tsc --noEmit (strict); CI runs it before the tests
npm test                       # node --test "test/*.test.ts" — no network
node --test test/app.test.ts   # one test file
node --test --test-name-pattern="<regex>" test/app.test.ts   # one test
npm run build                  # dist/wow-forever-essentals-updater.exe + dist/wow-forever-essentals-updater-linux-x64
node scripts/build.mjs win-x64 # or linux-x64 (also `make windows` / `make linux`)
```

There is no linter. Node runs the .ts files directly (type stripping, no flag on Node 24), so the TypeScript must stay erasable: no enums, namespaces or parameter properties, type-only imports written as `import type`, and relative imports spelled with `.ts`. The build downloads and sha256-verifies the official Node binaries into `build/` (gitignored) and injects an esbuild bundle (`build/bundle.cjs`, entry `src/main.ts`) with postject. To try the real CLI without touching your config, set `WFE_UPDATER_HOME` to a temp dir and pass `--addons <temp dir>`.

## Architecture

Layers, from the outside in. A module may import from its own layer and the ones below it, never from above.

```
src/
  main.ts          process entry: runs main(), maps errors to exit codes, --pause-on-exit
  cli.ts           main(argv, test?): parseArgs, wiring, command switch. No side effects on import
  errors.ts        UsageError          types.ts   Deps, Options (the side-effect seam)
  globals.d.ts     declares __APP_VERSION__ (esbuild `define`)
  semver.ts        selfupdate.ts
  menu/            interactive menu: menu.ts (loop), dashboard.ts, addons.ts, settings.ts
  commands/        one file per command (update, remove, status, detect, clean, add); may print
  engine/          plan.ts (inspect/makePlan), install.ts (installItem), addons-dir.ts (resolveAddons); no prompts
  catalog/         builtin.ts (addons as data), spoken.ts (everything Spoken-specific), catalog.ts (Items), custom.ts (addons.json)
  config/          paths.ts (dirs, readJson/writeJsonAtomic), config.ts (config.json), state.ts (state.json)
  sources/         source.ts (types), github.ts, wago.ts, fixed.ts, multi.ts, notes.ts
  net/             http.ts, download.ts
  disk/            zip.ts, toc.ts, swap.ts, lock.ts, platform.ts, fold.ts, tree.ts
  detect/          detect.ts, productdb.ts, buildinfo.ts
  ui/              term.ts (colour, symbols, truncate/pad, banner), log.ts, progress.ts, prompts.ts, ask.ts
```

**Layering rule.** `disk/`, `net/`, `sources/`, `detect/`, `config/` and `catalog/` never import `ui/` (except `ui/log` for output). `engine/` may also use `ui/progress` and `colorOn` from `ui/term`. Only `commands/`, `menu/` and `cli.ts` import `ui/prompts` or the rest of `ui/term`. **All side effects go through the `Deps` object** (`source`, `fetchImpl`, `env`, `runningWow`, `ask`, `configDir`, `cacheDir`), which is how tests run the whole flow against fake servers and fake AddOns trees. Keep new I/O behind `deps`.

- Commands: `update` (`commands/update.ts`) is `inspect` -> plan -> download -> extract -> swap, using `engine/`. `commands/remove.ts` (`uninstall`) moves the state-recorded folders through `swapIn({ roots: [], remove })`, so backup, rollback and the in-use-folder fallback come for free. `commands/add.ts` is the add-from-GitHub flow (menu and `add` command): probe the latest release, download the zip into the normal cache, list its addon folders with `zipAddonFolders` (central directory only), confirm, write `addons.json` and `selected`. `devCopyReason` (`disk/platform.ts`) marks links and `.git` folders as developer copies that `inspect`, `installItem` and `uninstall` leave alone unless `--overwrite-dev`.
- Menu refresh: `menu/menu.ts` races its main prompt against a timer (`REFRESH_MS`, 5 min; only with a real keyboard). The timer aborts the prompt through an `AbortSignal` (`choose(..., signal)` in `ui/prompts.ts`), the dashboard is redrawn, and a `found` update (`addon@version`) not seen before rings the bell and calls `deps.notify` (`ui/notify.ts`: PowerShell toast on Windows, `notify-send` on Linux; absent in tests, which pass their own deps).
- UI: `ui/term.ts` is the look: colour on/off (`NO_COLOR`, `FORCE_COLOR`, TTY), Unicode vs ASCII symbols (`WFE_ASCII`), banner, `truncate`/`pad` that ignore colour codes. `ui/log.ts` has the output helpers; `log.scoped(id, title)` prints a titled block on a terminal and `[id] ...` lines when redirected. Anything redrawn in place must go through `truncate`, or wrapped lines break the cursor-up redraw. `ui/prompts.ts` has the `choose`/`checklist` prompts: arrow keys via readline keypress events on a raw-mode TTY, numbered line input through `io.ask` otherwise.
- Catalog: `catalog/builtin.ts` holds the built-in addons as data (`BUILTIN`: repo, folders, title); `catalog/custom.ts` loads/validates/edits the user's `addons.json` (same shape, never throws on bad input, refuses `Blizzard_*` and folders another addon owns) and parses repo addresses. `catalog/catalog.ts` turns both, plus Spoken (the one multi-item special case, all in `catalog/spoken.ts`), into `Item`s: `listGroups(custom)` is what the menu selects, `buildCatalog({ selected, custom, pinned, ... })` returns the items. An `Item` carries its `repo`, `tagMode` (`prefix` for Spoken's `<prefix>/<version>` tags, `plain` for `vX.Y.Z`), `owns(folder)`, optional `letterSuffix`, `assetPattern` (regex picking the zip) and `pin`. **`owns` is the safety rule**: an item may only write or remove folders it owns (Spoken: `/^spoken/i`; every other addon, built-in or custom: its declared `folders`). Item ids (`spoken`, `quests-audio`, `luzenna-forever`, custom ids...) are state keys, cache keys and `--only` names, so keep them stable. Spoken's `replaces` lists retired 2.x items/folders that must be removed in the same transaction as the 3.x install or lines are voiced twice.
- Sources: `sources/source.ts` is the `Source` interface; `github.ts` implements it for one repo (newest stable by semver, multi-flavor zip, sha256 digest check); `wago.ts` implements it for addons only released on Wago Addons (no public API, so it parses the `data-page` JSON of the public addon page, takes the `forever` flavor, and resolves the zip's CDN URL and size with one HEAD on the download link; no sha256; versions can be bare build numbers, hence `Item.loose` and `semver`'s `{ loose: true }`); `multi.ts` routes each item to a `GitHubSource` for its `item.repo`, or to the `WagoSource` when it has `item.wago`. `fixed.ts` serves an entry with `url: { version, href, size, sha256 }` as a single pinned release with no requests (a temporary stop-gap for What's Training, whose author disabled third-party downloads on CurseForge; it never updates on its own). Built-in entries flagged `optIn` are off in a fresh config (`DEFAULT_SELECTED`), and `requires` (Baganator -> Syndicator) is expanded by `withRequired` in `catalog/catalog.ts`. `semver.ts` has an opt-in `{ letters: true }` mode where `1.0.5-f` is a later build of `1.0.5` (Dialogue UI's rebuild tags), not a prerelease. `sources/notes.ts` boils release notes down for the "what's new" lines.
- `detect/` finds the AddOns folder: Battle.net `product.db` (`productdb.ts`), build info, registry, common folders, and on Linux Proton/Lutris/Heroic/Bottles/wine prefixes; `disk/fold.ts` does case-insensitive path lookups (Linux/Wine).
- `net/download.ts` (resume with Range, retry/backoff, cache), `disk/zip.ts` (yauzl; path normalisation and zip-slip refusal), `disk/swap.ts` (rename-based swap with backup, rollback and a crash-recovery journal; a folder another program is working in, which Windows won't rename, is emptied into the backup and refilled in place; also looks for a journal under the old `.spoken-updater` work dir), `disk/lock.ts`, `disk/platform.ts` (free space, running-WoW check), `config/` (`config.json` with `selected`, `state.json`, one-time `migrateLegacy` copy from the old `spoken-updater` dir), `selfupdate.ts` (replaces the executable from this tool's own GitHub releases, then restarts into it).
- The `.toc` of each installed folder (`disk/toc.ts`) is the source of truth for installed version; `state.json` only supplies folder names and the size baseline. When a `.toc` Version doesn't match the release tag, `inspect` falls back to "same tag as recorded in state means current".

## Tests

`node:test` in `test/`. `test/helpers.ts` provides an in-memory stored-zip writer (`makeZip`, which writes names verbatim so tests can use backslashes or `../`), temp dirs, and a local HTTP server serving fake release zips. `test/app.test.ts` covers Spoken end to end, `test/addons.test.ts` the plain-tag addons and migration, `test/custom.test.ts` addons.json, adding/removing, developer copies, pins and notes, `test/menu.test.ts` the prompts, the menu loop and the entry rules (a `PassThrough` stands in for the keyboard), `test/ui.test.ts` colours, widths and the dashboard rows. Add tests in this style rather than touching the network.

### Testing the interactive menu (do this for any change to `menu/`, `ui/` or `cli.ts`'s menu entry)

`npm test` is not enough for the menu. Most menu tests answer through the numbered fallback (`scripted([...])`), which never touches the arrow-key path a real terminal uses, and they cannot see what is on screen. Two bugs got to a release that way (the addon selector left the old dashboard on screen and dragged you into Spoken's voice packs on every confirm). So also **use the real app in a real pseudo-terminal and look at the screen**:

```
python -m venv "$TEMP/wfe-venv"                         # once, outside the repo
"$TEMP/wfe-venv/Scripts/python" -m pip install -r scripts/ui/requirements.txt   # Linux: bin/python
PYTHONUTF8=1 "$TEMP/wfe-venv/Scripts/python" scripts/ui/select-addons.py        # exits 1 and lists what is wrong
```

- `scripts/ui/drive.py` runs the real CLI in a ConPTY (Windows, `pywinpty`) or a Unix pty (`ptyprocess`), feeds real key bytes (`s.send(s.DOWN)`, `s.SPACE`, `s.ENTER`, `s.ESC`) and renders the screen with `pyte`, so `s.screen()` is what the user sees: stale lines, wrong cursor, a prompt that should not have opened.
- `scripts/ui/select-addons.py` is a worked scenario with assertions. For a new menu flow, copy it, drive the flow by hand first and read `s.screen()` after every key, then turn what you saw into assertions.
- The scenario talks to GitHub for real (the dashboard rows need release data). Anonymous API calls are limited to 60 an hour, so after many runs every addon shows "couldn't check for updates" and the last assertion (DialogKey shown as selected) fails for that reason alone; wait for the limit to reset, or set `GITHUB_TOKEN` for the run. `drive.py` removes `NO_COLOR` from the environment it gives the app, because with it the app stops clearing the screen.
- It always runs against a throwaway config and AddOns folder (`WFE_UPDATER_HOME` plus `--addons <temp dir>`, as the scripts do), never the real ones, and with `--no-self-update`.
- When fixing a menu bug, first reproduce it with a script and check that it fails on the old code (`git show HEAD:src/menu/menu.ts`), then fix it, then add a regression test in `test/menu.test.ts` using the raw-key `keyboard()` helper (it records what was drawn via `k.text()`; use `until(...)` before pressing keys so none are sent before their prompt exists).
- Do not drive the user's own windows with the desktop-control tools (Windows MCP) or send them keystrokes, and do not kill their processes. A console launched that way may have no visible window. The pseudo-terminal approach above needs none of that.

## Releases

Pushes to `main` touching `src/`, `scripts/`, `tsconfig.json` or `package*.json` auto-release via `.github/workflows/release.yml`. The version bump is driven by commit subject markers: `#minor`/`[minor]`, `#major`/`[major]`, `#norelease`, `#release` (default is patch). Mind these markers when writing commit messages. Releases publish only the `wow-forever-essentals-updater` binaries (the old `spoken-updater`-named copies were dropped once the existing installs had updated; releases up to v1.1.1 still carry them). `SELF_REPO` in `src/selfupdate.ts` must match the real GitHub repo name.

`.github/workflows/ci.yml` runs the type check, the tests (Linux and Windows) and a Linux build with smoke test on every branch push and pull request; pushes to `main` get the same checks from the release workflow.
