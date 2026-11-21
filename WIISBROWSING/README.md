# WIISBROWSING

A real Windows web browser: a native WPF application on the Chromium engine (Microsoft Edge WebView2), with Opera-style
vertical tabs, a workspace sidebar, tab clusters, a command bar, sleeping tabs, ad blocking, private windows and profiles.

> Your internet. Reimagined.

This is **version 0.1.0 — a first milestone**. Everything marked *works* below was observed running in the real browser
(see [Verification](#verification)). What is **not** built yet is listed plainly in [docs/FEATURES.md](docs/FEATURES.md) —
nothing there is faked.

## Install

* **Installer:** `release\WIISBROWSING_0.1.0_x64-setup.exe` — per-user, no administrator rights, adds a Start Menu entry
  (and an optional desktop shortcut), registers WIISBROWSING in *Windows Settings → Default apps*. It does **not** change
  your default browser.
* **Portable:** run `release\WIISBROWSING\WIISBROWSING.exe` directly.
* **Silent install:** `setup.exe /S /DESKTOP /D=C:\path\to\folder` · **Silent uninstall:** `Uninstall.exe /S` (add `/DELETEDATA`
  to also remove browsing data).
* **Set as default browser:** *Settings → General → Open Windows default apps*, or Windows Settings → Apps → Default apps →
  WIISBROWSING. Windows always asks you; the app never switches silently.

Requirements: Windows 11 (the version it was built and tested on; Windows 10 should work but is untested), x64, and the *Microsoft Edge WebView2 Runtime* (included with Windows 11 and
with Microsoft Edge; the installer tells you if it is missing). The .NET runtime is bundled — nothing else to install.

## Build from source

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1      # tests -> publish -> installer -> release\
powershell -ExecutionPolicy Bypass -File scripts\selftest.ps1   # end-to-end browser test (see below)
dotnet test tests\WIISBROWSING.UnitTests                         # unit tests only
dotnet run --project src\WIISBROWSING.App                        # run from source
```

Needs the .NET 10 SDK and (for the installer) NSIS — `build.ps1` finds the NSIS that Tauri downloads, or a normal NSIS
install. The solution is `WIISBROWSING.sln`.

## What it has

* **Real browsing** — HTML5/CSS/JS, HTTPS, cookies, IndexedDB, WebSockets, WebAssembly, video/audio, uploads, DevTools (F12).
* **Vertical tabs (default)** — resizable panel, compact rail, left/right, or classic horizontal; hidden strip with keyboard
  navigation. Switching layouts never reloads a page.
* **Workspaces** (General, Gaming, Development, Study, Entertainment — all editable) and **WIISB Clusters** (manual groups,
  colours, emoji, collapse; local rule-based suggestions, never sent anywhere). Pinned tabs, tab markers, duplicate finder,
  recently-closed tabs, hover preview cards, tab search across windows (Ctrl+Shift+A).
* **Command bar (Ctrl+K)**, 100+ commands, every shortcut from the spec, rebindable with conflict detection.
* **Omnibox** — URL/search/localhost classification, history + bookmark + open-tab suggestions (search suggestions are opt-in).
* **Sleeping tabs** + **WIISB Control** (real memory/CPU of the browser's processes), Performance / Balanced / Battery /
  Memory modes, Gaming mode.
* **Ad & tracker blocking** (host-based, real counts, per-site off switch, EasyList/EasyPrivacy on demand) and the engine's
  tracking prevention (Off / Balanced / Strict).
* **Private windows** with a separate throw-away data folder and no history/session store; **profiles** with separate data.
* **Downloads** with pause/resume/cancel, speed and ETA, Mark-of-the-Web, warnings for programs and scripts.
* **Bookmarks**, history, session restore + crash recovery, import bookmarks from Chrome/Edge/Brave/Opera/Vivaldi/Firefox,
  backup & restore.
* **15 themes** (14 built in + custom editor with live preview, import/export), animated new-tab backgrounds, wallpaper.
* New-tab page with Speed Dial, workspace shortcuts, onboarding; reader mode, read aloud, notes (Markdown), screenshots,
  find, print/PDF, mini tools; sidebar web apps in side panels; unpacked-extension support (limited, see docs).

## Where things are

| | |
|---|---|
| Executable (installed) | `%LOCALAPPDATA%\Programs\WIISBROWSING\WIISBROWSING.exe` |
| Browser data | `%LOCALAPPDATA%\WIISBROWSING` (profiles, logs, cache) — never in Program Files, never in this folder |
| Screenshots | `Pictures\WIISBROWSING` |
| Source | `src\WIISBROWSING.Core` (logic, data, tested) · `src\WIISBROWSING.App` (WPF + WebView2) |
| Tests | `tests\WIISBROWSING.UnitTests` (102 tests) · `scripts\selftest.ps1` (30 end-to-end checks) |

## Verification

* `dotnet test` — 102 unit tests: URL classification, search templates, history/bookmark/session/profile stores (real SQLite),
  private-mode isolation, ad-block rules, themes (validation of imported files), clusters, duplicates, commands and shortcuts.
* `scripts\selftest.ps1` — launches the real browser with a local web server and checks, by observing the engine: navigation,
  titles/favicons, back/forward/reload, redirects, error pages, a real download (bytes + Mark-of-the-Web), permission prompts,
  popups, ad blocking, find, zoom, tab sleeping with scroll restore, clusters/workspaces, layout switching without reload,
  themes, shortcuts, bookmarks, WIISB Control, all 13 internal pages, settings validation, the page-to-browser bridge being
  closed to websites, private-window isolation (cookies, history, session), five real HTTPS sites, session snapshot — then a
  **second process** that must restore the saved session.

Last result on the release build and on the installed copy: **30 passed, 0 failed** (29 on the installed copy before the
real-sites check was added).

Not covered by automated checks (checked by eye only, or not at all): window snapping and multi-monitor/high-DPI moves, F11 and
page fullscreen visuals, drag-and-drop gestures, adding an extension, importing from other browsers' real data, the crash-recovery
prompt, and DRM/streaming playback. See docs/FEATURES.md.

## Security in one paragraph

Websites can't reach the browser: internal `wiisb://` pages are static files served by the app (CSP, no framing), only they can
send commands, and each command and setting is validated against a fixed list. Certificate errors are shown by the engine's
own warning page. External-app links are limited to a short safe list and always ask first. Downloads never run on their own.
The renderer sandbox, site isolation and SmartScreen are left on. Details: docs/ARCHITECTURE.md.

## Privacy

No accounts, no telemetry, no hidden requests. Data stays on this PC. The only network requests the app itself makes are ones
you trigger (search suggestions if you turn them on, downloading filter lists). Private windows do not hide you from websites,
your network or your internet provider.
