# Bracket Maker (Tauri)

A native desktop rewrite of the Electron **Bracket Maker / Tournament Hub** app, for macOS and Windows.
It supports Round Robin, Swiss, Single Elimination and Double Elimination, with check-in, seeding, live standings and encrypted backups.

## Download

Get the latest installers from the [Releases page](https://github.com/SkillzNoLogic/bracketbind/releases/latest):

| Platform | File | Notes |
|---|---|---|
| macOS (Apple Silicon + Intel) | `Bracket Maker_<version>_universal.dmg` | Open it and drag the app to Applications |
| macOS (Apple Silicon + Intel) | `Bracket Maker_<version>_universal.pkg` | Installer that puts the app in /Applications |
| Windows 10/11 (64-bit) | `Bracket Maker_<version>_x64-setup.exe` | Per-user installer, no admin rights needed |

The builds aren't code-signed. On macOS, right-click the app (or the .pkg) and choose **Open** the first time.
On Windows, click **More info → Run anyway** in SmartScreen.

The original HTML was extracted from `/Applications/Bracket Maker.app/Contents/Resources/app.asar`
and is kept unchanged in `extracted/` for reference and for the compatibility tests.

## Layout

```
src/                 Frontend (plain HTML/CSS/ES modules, no build step)
  index.html
  styles.css
  viewer.html        Spectator page served on the local network
  js/engine.js       Tournament logic (pure, no DOM, unit tested)
  js/views.js        Shared rendering: match lists, standings, bracket visualiser
  js/app.js          Desktop UI
  js/viewer.js       Spectator site (read-only, live updates)
  js/backup.js       THUB10/THUB11 backup codes (compatible with the old app)
  js/zip.js          .zip read/write for history archives
  js/platform.js     Tauri bridge (falls back to browser APIs)
  js/icons.js
src-tauri/           Rust shell: storage, native dialogs, menu, legacy import, live web server
tests/               node --test suite; compares the engine with the original app's code
.github/workflows/   CI that builds the .dmg (universal) and the Windows installers
```

## Develop

Prerequisites: Node 18+, Rust (via rustup), and on macOS the Xcode command line tools.

```sh
npm install
npm run dev          # launches the app with live reload of src/
npm test             # engine + backup + zip tests
```

## Build

```sh
npm run build                    # this machine's architecture → src-tauri/target/release/bundle/
npm run build:mac-universal      # Apple Silicon + Intel .app/.dmg (needs both rustup targets)
```

**macOS .pkg:** after a build, run `scripts/make-pkg.sh "<path>/Bracket Maker.app" "Bracket Maker.pkg"`.

**Windows installer** (`.exe`) must be built on Windows. Either run `npx tauri build --bundles nsis` on a Windows PC
(it needs the Rust MSVC toolchain and the Visual Studio C++ build tools), or push a `v*` tag. The **Build & release**
workflow then builds the Windows `.exe` and the universal macOS `.dmg` and `.pkg`, and attaches them to the GitHub release.

The builds are not code-signed. The first time you open the app on macOS, right-click it and choose **Open**.
On Windows, choose **More info → Run anyway** in SmartScreen.

## Live website

While a tournament is open, the app serves a read-only spectator site on your local network, at
`http://<this computer's IP>:8787`. Open **Live Website** (⌘L) for the link and a QR code that phones can scan.
The page updates within a second of any change and works on phones. You can turn it off or change the port in Settings.
If the port is busy, the next free port is used.

The first time it starts, macOS or Windows may ask whether to allow incoming network connections. Allow it on
private networks so other devices can connect. Only `GET` requests are accepted and nothing can be changed from the site.

## Version 2.1

- **Liquid Glass redesign:** translucent materials with specular rims, a floating glass sidebar, large titles,
  capsule toolbars, segmented tabs with a sliding thumb, sheets in place of pop-up windows, and spring animations.
  It follows the system light/dark setting. The decorative emojis are gone (medals are now rank badges, trophies are icons).
- **Bracket visualiser:** a real tree layout with connector lines. Matches sit between the matches that feed them.
  It has winners and losers tracks, a champion card and the third-place match. Hover a player to trace their path.
  Zoom with the buttons or ⌘/Ctrl + scroll, drag to pan, and click a match to edit it. Swiss rounds are grouped into
  record pools, and Round Robin has a colour-coded grid.
- **Up next** strip of matches that are ready to play, plus a larger match editor with steppers and quick-win buttons.
- **Tournament logic:**
  - Swiss pairings are locked once a round is generated, and a **Re-pair** button is available until results are entered.
  - Swiss avoids rematches with backtracking, and the number of rounds is configurable.
  - Buchholz tiebreak for Swiss.
  - Head-to-head ties are settled with a transitive mini-table.
  - Optional third-place match in Single Elimination.

## What changed compared with the Electron version

**Platform**
- Tauri instead of Electron: roughly a 10 MB download instead of about 250 MB, and it uses the system webview.
- Data is saved to `state.json` in the app data folder (Settings → *Show folder*), not to `localStorage`, so there's no storage quota. Writes are atomic, the previous copy is kept as `state.json.bak`, and a daily snapshot is kept for 14 days.
- On first launch, tournaments, settings and theme are imported automatically from the old Electron app's storage (`test-app` / `Bracket Maker` profiles). There's also a button for this under Import & Export.
- Native menus with keyboard shortcuts: ⌘N, ⌘O, ⌘E, ⌘P, ⌘Z / ⇧⌘Z, ⌘F, ⌘B, ⌘1–4, ⌘, (Ctrl on Windows).
- Native save/open dialogs, window size and position remembered, and a single running instance.
- Drop `.txt` / `.zip` / `.json` backups anywhere on the window to import them.
- The browser's `alert`/`confirm`/`prompt` popups are replaced with in-app dialogs and toasts.

**Tournament engine** (same match IDs, so old saves and backup codes load unchanged)
- Editing an earlier elimination or Swiss result no longer hands the old downstream score to a different matchup. Affected matches reset.
- Removing a player no longer wipes every score. Only matches whose players changed are reset.
- Round Robin results follow their pairing if the round order shifts.
- Two disqualified players meeting no longer deadlocks the bracket. The match counts as a double forfeit and the next opponent gets a bye.
- Single and Double Elimination produce real placements (1st, 2nd, T3rd, T5th…).
- A score can't be set so that both players reach the win threshold.

**New features**
- Undo/redo for every change, including score edits, DQs, renames, removals and resets.
- Rename players or the tournament, and add players during a tournament.
- Setup wizard with a step indicator. Press Enter to add the next player, paste a list to add many at once, and duplicates are highlighted.
- Seeding by drag (pointer based, so it works in native webviews), arrow buttons, randomize, or A–Z.
- Filter matches by player or round, and hide finished matches.
- Round Robin crosstable, a Double Elimination map split into winners and losers brackets, and a champion column for Single Elimination.
- Player card with a full match history.
- Final-results podium, results export as `.txt` or `.csv`, and a print layout that includes the bracket.
- History search and sort, rematch with the same roster, and delete with undo.
- Full JSON backup and restore of everything, alongside the THUB codes and the `.zip` history archive.
- Light, Dark or System appearance.
