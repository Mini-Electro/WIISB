# Architecture

## Engine decision: WebView2 (Chromium) rather than CEF

| | WebView2 | CEF |
|---|---|---|
| Engine | Chromium, updated by Microsoft's Evergreen runtime (security fixes without shipping a new browser) | Chromium, **we** must rebuild/redistribute for every security release |
| Footprint | App ≈ 140 MB self-contained; engine is shared with Edge | +200–300 MB engine in the installer |
| Windows integration | Native HWND hosting, DPI, printing, PDF, downloads, permissions, DevTools, tracking prevention, profiles, in-private mode and extensions are first-class APIs | Most are wired by hand |
| Extensions | Unpacked MV2/MV3 via `Profile.AddBrowserExtensionAsync` | Limited / manual |
| Weaknesses | Not the full Edge browser: no Web Store, no sync, some browser-level features missing (documented) | More control, much more to own |

Decision: WebView2. A security-critical engine that someone else patches is worth more than the extra control CEF offers, and every
required capability that was built has a supported API. Where WebView2 can't do something, the app says so (see FEATURES.md).

## Projects

* **WIISBROWSING.Core** (net10.0, no UI): `Urls` (omnibox classification, search templates), `Data` (SQLite with versioned
  migrations, per-profile stores, profile registry), `Privacy` (ad-block engine), `Themes` (tokens + validation), `Tabs`
  (cluster suggestions, duplicate detection), `Commands` (registry, fuzzy search, shortcut map). Fully unit-tested.
* **WIISBROWSING.App** (net10.0-windows, WPF):
  * `Views/MainWindow.*` — one window, split by area (Tabs, Toolbar, Panels, Commands, Support); `VerticalTabPanel`,
    `PaletteWindow`, `Dialogs`.
  * `Browser/TabWebView` — the only class that talks to a tab's WebView2: wires every engine event into `BrowserTab` state.
  * `Services/TabManager` — workspaces, clusters, tabs (stable ids), closed-tab stack, session snapshots; no UI knowledge, so a
    layout change is just a different view of the same collection.
  * `Services/*` — `ThemeManager`, `WebEnvironments`, `DownloadService`, `InternalPages` + `InternalApi` (the wiisb:// bridge),
    `FaviconCache`, `ReaderMode`, `Speech`, `ResourceMonitor`, `SelfTest`.
  * `Assets/internal` — the wiisb:// pages (plain HTML/CSS/JS, embedded in the exe).

## Data layout (`%LOCALAPPDATA%\WIISBROWSING`)

```
app.db                       profiles list + app-wide settings (theme, window bounds)
profiles\p-<id>\browser.db   history, bookmarks, downloads, workspaces/clusters/tabs, notes, permissions, settings
profiles\p-<id>\web\         the engine's own data for that profile (cookies, cache, storage)
private-temp\<guid>\         throw-away data of a private window (deleted on close; swept at next start after a crash)
cache\favicons               small icon cache (capped)   logs\   adblock\   themes\   backups\
```

SQLite runs in WAL mode; the whole session is saved in one transaction (a failed save leaves the previous session intact —
unit-tested); migrations take a `.bak-vN` copy first and refuse data from a newer schema.

## Private windows

A private window gets (1) its own temporary WebView2 user-data folder **and** the engine's in-private controller option, (2) a
`ProfileData` view with **no history store and no session store** (the objects don't exist, so nothing can write to them),
(3) in-memory permissions and download records, (4) previews and favicons in memory only. Bookmarks/notes/settings are shared on
purpose (you can save a bookmark from a private window). Verified: separate cookie jar, no history row, no session.

## Security model

* Pages from the web are untrusted. `AreHostObjectsAllowed = false`. The web-message handler drops anything not sent by a
  `wiisb://` document; `wiisb://` pages are served from embedded resources with a strict CSP and `frame-ancestors 'none'`.
* Internal pages never put page data into HTML: elements are built with `textContent`. Reader mode extracts *blocks* in the page
  and rebuilds them as elements.
* Every `settings.set` is validated per key (type, range, enum, path, URL); themes imported from files are schema-validated
  (known colour tokens, hex only, bounded numbers, font names without markup).
* The command list is fixed; external protocol launches are limited to a safe list and need a click; `javascript:`/`data:` can't
  be typed into the omnibox; file/launcher paths are normalised (`..` is refused by the engine anyway).
* Not changed: renderer sandbox, site isolation, certificate validation, SmartScreen reputation checks.
* Passwords: handled entirely by the engine's own save/fill. The app has no password store and never reads credentials.

## Airspace

WebView2 is a native child window: WPF can't draw over it. Everything that floats over a page (command bar, menus, popovers,
toasts, link status) is a separate window/popup; anything that needs to *replace* the page (error/crash screen) hides the web view
and shows a WPF panel in the same spot. Panels that sit beside the page (side panel, tab panel) are ordinary layout.

## Known engine limits that shaped the design

* A tab can't be re-parented to another window without recreating its engine view, so "move tab to new window" re-opens its
  address (page history isn't carried).
* `CapturePreview` hangs on hidden views, so previews are taken while the page is visible and captures time out.
* The WPF control hides its controller; page-focused shortcuts are enabled by reading it through reflection (`HasAcceleratorHook`
  is tested, and the app degrades to UI-focused shortcuts if a future SDK moves it).
* WPF freezes brushes stored in application resources, so theme changes swap frozen brushes frame by frame instead of animating
  one shared brush.
