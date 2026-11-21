# WIISB Launcher

A native Windows game-library launcher for games that are **already installed** on your PC.
Built with **Tauri 2 + Rust** (native backend), **React + TypeScript + Vite + Tailwind CSS** (UI) and **SQLite** (local data).

It is not an installer, downloader or store. It never modifies, moves or deletes game files, and it does not touch DRM,
licensing or anti-cheat.

## What it does

- Finds your games and shows them as a library. The four built-in titles — **DELTARUNE, Persona 3 Reload, ULTRAKILL, UNDERTALE** —
  are looked for in your library folder (default `E:\bbsgames`). The scan is read-only, bounded, never follows
  symlinks/junctions and never executes anything.
- **Detects other games too** (Settings → Library → *Game detection*, on by default): every Steam library folder (real app IDs from
  Steam's own manifests), Epic Games (launch links built from Epic's manifests), Roblox, games with Start Menu shortcuts, and extra
  game folders inside your library folder. Detection only reads files other launchers already keep. Remove anything that isn't a game
  from its page — it can be restored in Settings. Add anything it missed with **Add game**.
- **Whole-PC scan** (*Scan whole PC* in the Library page or Settings → Library): searches every local drive for installed games and
  shows a checklist — nothing is added until you pick it. Games are recognised by how they are built (Unity `_Data` folders, Unreal
  `Binaries\Win64` beside `Content`, GameMaker `data.win`, Godot `.pck`, RPG Maker, Ren'Py, GOG, Steamworks, anti-cheat), not by name,
  so ordinary programs don't appear. It is read-only, runs at low CPU/disk priority, skips Windows/AppData/cache folders, never follows
  symlinks or junctions, skips games already in your library, and can be stopped at any time. Command line: `wiisb-launcher.exe --scan-pc`.
  Microsoft Store / Xbox titles whose files Windows protects can't be read by other programs, so they can't be found this way.
- **Covers and icons:** posters and banners come from Steam's public store (looked up by title, saved in the app's data folder; only the
  title is sent; switch it off in Settings). Games Steam doesn't know — Roblox, Fortnite, local folders — use the program's own icon.
  You can always choose your own image.
- **Change the library folder** (Settings → Library → *Change folder…*) and **change any game's installation** (*Locate / Change installation…*,
  or Settings → Game Launching → installation folder). Games don't have to live inside the library folder.
- Launches games through a native Rust pipeline (direct `.exe`, verified platform link, or Windows shortcut), confirms the real game
  process, and records **real sessions** (start, end, duration) in SQLite.
- Statistics, favourites, notes, custom artwork, themes, tray, notifications, start-with-Windows.

Nothing is imported silently from folders you didn't configure: detection covers your library folder and the launchers' own game lists.

## Install / run

After building (below), the installers are in `src-tauri\target\release\bundle\`:

| File | Notes |
|------|-------|
| `nsis\WIISB Launcher_1.0.0_x64-setup.exe` | Per-user installer (no admin needed). Creates Start Menu and Desktop shortcuts. |
| `msi\WIISB Launcher_1.0.0_x64_en-US.msi` | Windows Installer package. |
| `..\wiisb-launcher.exe` (`src-tauri\target\release\`) | The portable executable. |

Launch **WIISB Launcher** from the Start Menu or desktop shortcut.

## Build from source

Prerequisites (Windows 10/11): Node.js 20+, Rust (stable, MSVC toolchain), Visual Studio 2022 Build Tools with the
*Desktop development with C++* workload and a Windows SDK, and the WebView2 runtime (preinstalled on Windows 11).

```powershell
npm install

npm run tauri:dev      # development with hot reload
npm run tauri:build    # production exe + installers
# or: powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

## Tests

```powershell
npm test               # frontend unit tests (Vitest): stats, search/sort/filter, theme, formatting
npm run test:rust      # backend tests: discovery, validation, launching/supervision (mocked), database, settings…
npm run build          # type-check + production frontend bundle
```

Backend tests never launch a real game — process spawning and process inspection sit behind traits and are mocked.
There is also an opt-in, read-only probe of your real library:

```powershell
cd src-tauri
cargo test real_library_probe -- --ignored --nocapture
```

## Where things are

```
src/                 React UI  (app, components, pages, features, hooks, services, stores, styles, types, utils)
src-tauri/src/
  games/             catalogue (the 4 games), discovery scoring, validation, library service, arg parsing
  processes/         spawner, process inspection, tracker state machine, supervisor (sessions)
  database/          SQLite access + versioned migrations   (migrations/001_init.sql)
  settings/          preferences + close-behaviour rules
  platform/          Win32 helpers, system tray, window state
  commands/          the IPC surface exposed to the UI
tests/               frontend tests
scripts/             icon + build scripts
```

User data lives in `%LOCALAPPDATA%\com.wiisb.games\` — `wiisb.db` (SQLite), `artwork\` (images you chose) — and logs in
`%LOCALAPPDATA%\com.wiisb.games\logs\`. Uninstalling does not delete your data.

## How launching and tracking work

1. **PLAY** re-validates the installation (drive present, file exists, valid PE executable), then calls the native `launch_game` command.
2. A second launch of a game that is already launching/running is refused. If a matching process is already running, it is adopted instead of starting a second copy.
3. The state becomes **Launching**. When a process from the game's installation folder is actually seen, the state becomes **Running** and the session starts.
   Launcher → game hand-offs are handled by watching the installation folder, not just the PID that was started.
4. If nothing can be confirmed within the timeout, the UI says **Launch requested** — it never pretends the game is running — and no time is recorded.
5. When the game exits (with a short grace period), the session ends at the last moment it was seen running.
6. Sessions have a heartbeat. After a crash or shutdown the session is closed at its last heartbeat. Closing WIISB Launcher never closes a game; on the next start the same still-running process is resumed (matched by process start time) and no time is double-counted.

Arguments are parsed into a list and passed to Windows as separate parameters; there is no shell and no free-form command field.
Platform links must use an allow-listed scheme (`steam`, `com.epicgames.launcher`, `goggalaxy`, …) and you supply the link — IDs are never guessed.

## Keyboard shortcuts

`Ctrl+K` search · `Ctrl+B` sidebar · `Ctrl+1…6` pages · `Ctrl+,` settings · `Alt+←` back · `Esc` back (game page)

## Known limitations

- Games that hide their process from other programs (some anti-cheat / elevated games) can only be shown as **Launch requested**.
- A game that requires administrator rights cannot be started by a non-elevated launcher; WIISB Launcher never elevates on its own.
- Window drag/resize use a custom title bar; Windows 11 snap-layout flyout on the maximise button is not available with custom window chrome (Win+Arrow snapping still works).
