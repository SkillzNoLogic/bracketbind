# Bracket Maker

A desktop tournament manager for macOS and Windows, built with Tauri.
It runs Round Robin, Swiss, Single Elimination and Double Elimination events with check-in, seeding,
live standings, a bracket visualiser and encrypted backups.

## Download

Get the latest installers from the [Releases page](https://github.com/SkillzNoLogic/bracketbind/releases/latest):

| Platform | File | Notes |
|---|---|---|
| macOS (Apple Silicon + Intel) | `Bracket Maker_<version>_universal.dmg` | Open it and drag the app to Applications |
| macOS (Apple Silicon + Intel) | `Bracket Maker_<version>_universal.pkg` | Installer that puts the app in /Applications |
| Windows 10/11 (64-bit) | `Bracket Maker_<version>_x64-setup.exe` | Per-user installer, no admin rights needed |

The builds aren't code-signed. On macOS, right-click the app (or the .pkg) and choose **Open** the first time.
On Windows, click **More info → Run anyway** in SmartScreen.

## Features

**Formats**
- Round Robin, Swiss, Single Elimination and Double Elimination, with series lengths from Best of 1 to Best of 9.
- Swiss pairings lock once a round is generated and avoid rematches. The number of rounds is configurable, and a
  **Re-pair** button is available until a round has results.
- Optional third-place match in Single Elimination, and a grand-final reset in Double Elimination.
- Real placements for elimination formats (1st, 2nd, T3rd, T5th…).
- Tiebreaks: wins, then Buchholz (Swiss), game difference, a head-to-head mini-table among tied players, then points.
- Disqualifications forfeit a player's remaining matches. If two disqualified players meet, it counts as a double forfeit.

**Running an event**
- Setup wizard: name and format, players, check-in, then seeding. Press Return to add the next player or paste a whole list.
  Seed by dragging, with arrow buttons, by shuffling, or A–Z.
- An **Up next** list of matches that are ready to play, plus a match editor with + / − buttons and quick-win buttons.
- Undo and redo for every change, including scores, disqualifications, renames, removals and resets.
- Rename players or the tournament, and add or remove players mid-event. Results stay wherever a matchup is unchanged.
- Filter matches by player or round, and hide finished matches.
- Player cards with record, win rate, form and full match history.
- Final-results podium, results export to `.txt` or `.csv`, and a print layout that includes the bracket.

**Bracket visualiser**
- A tree layout with connector lines. Each match sits between the matches that feed it.
- Winners and losers tracks, a champion card and the third-place match.
- Hover a player to trace their path. Zoom with the buttons or ⌘/Ctrl + scroll, and drag to pan.
- Click a match to enter a result.
- Swiss rounds are grouped into record pools. Round Robin gets a colour-coded results grid.

**Live website**
- While a tournament is open, the app serves a read-only spectator site on your local network at
  `http://<this computer's IP>:8787`.
- Open **Live Website** (⌘L) for the link and a QR code that phones can scan.
- The page updates within a second of any change and works on phones.
- Turn it off or change the port in Settings. If the port is busy, the next free one is used.
- The first time it starts, macOS or Windows may ask whether to allow incoming network connections. Allow it on
  private networks. Only `GET` requests are accepted, and nothing can be changed from the site.

**Data**
- Saved automatically to `state.json` in the app data folder (Settings → *Show folder*). Writes are atomic,
  the previous copy is kept as `state.json.bak`, and daily snapshots are kept for 14 days.
- History with search, filters and sorting. Rematch with the same roster, and delete with undo.
- Backup codes (optionally password-encrypted with AES-GCM), `.zip` archives of every tournament,
  and a full JSON backup and restore. Drop backup files anywhere on the window to import them.

**App**
- Liquid Glass design: translucent materials, a floating sidebar, capsule toolbars and spring animations.
  Light, Dark or System appearance.
- Native menus and shortcuts: ⌘N, ⌘O, ⌘E, ⌘P, ⌘Z / ⇧⌘Z, ⌘F, ⌘B, ⌘L, ⌘1–4, ⌘, (Ctrl on Windows).
- Native save and open dialogs, remembered window size and position, and a single running instance.

## Project layout

```
src/                 Frontend (plain HTML/CSS/ES modules, no build step)
  index.html
  styles.css
  viewer.html        Spectator page served on the local network
  js/engine.js       Tournament logic (pure, no DOM, unit tested)
  js/views.js        Shared rendering: match lists, standings, bracket visualiser
  js/app.js          Desktop UI
  js/viewer.js       Spectator site (read-only, live updates)
  js/backup.js       Backup codes
  js/zip.js          .zip read/write for archives
  js/platform.js     Tauri bridge (falls back to browser APIs)
  js/icons.js
src-tauri/           Rust shell: storage, native dialogs, menus, live web server
scripts/make-pkg.sh  Wraps the built .app in a macOS installer package
tests/               node --test suite for the engine, backups and zip handling
.github/workflows/   CI that builds and publishes the installers
```

## Develop

Prerequisites: Node 18+, Rust (via rustup), and on macOS the Xcode command line tools.

```sh
npm install
npm run dev          # launches the app with live reload of src/
npm test             # engine, backup and zip tests
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
