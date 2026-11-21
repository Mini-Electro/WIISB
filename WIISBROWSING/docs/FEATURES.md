# Feature status (version 0.1.0)

Legend — **Verified**: observed in the real browser by the self-test or unit tests. **Built**: implemented and compiled, used by
the self-test only indirectly or not at all, so *not* proven. **Partial**: works with stated limits. **Not built**: absent.

## Core browsing

| Feature | Status | Notes |
|---|---|---|
| Real engine (WebView2/Chromium), real sites | Verified | example.com, Wikipedia, GitHub, YouTube, Google over HTTPS; DRM/streaming playback untested |
| Tabs: open/close/reorder/duplicate/pin/mute/reopen | Verified (logic + UI path) | drag-and-drop gestures themselves are not automated |
| Address bar: URL/search/localhost/IPv6, suggestions | Verified (classification) / Built (suggestion popup) | search suggestions opt-in |
| Back/forward/reload/stop, redirects, error pages | Verified | friendly page for DNS/refused/timeout/offline; certificate errors use the engine's own warning |
| Title + favicon updates | Verified | favicons cached per site |
| History (record, search, range delete, clear + VACUUM) | Verified | private windows record nothing |
| Bookmarks, folders, HTML import/export | Verified | |
| Downloads: progress, pause/resume/cancel, bytes, Mark-of-the-Web | Verified (download + bytes + MOTW) / Built (pause/resume) | programs/scripts get a warning before opening |
| Session restore + crash recovery | Verified (restore in a new process) / Built (the "closed unexpectedly" prompt) | only the first window of a profile is saved |
| Settings persistence + validation | Verified | |
| Multiple windows, private windows | Verified (private isolation) | |
| Profiles with separate data | Verified (registry + isolation of folders) / Built (UI) | |
| Find in page, zoom, print, save as PDF, screenshot, DevTools | Verified (find, zoom) / Built (print, PDF, screenshot, DevTools) | screenshot = visible area only, no editor |
| Fullscreen (F11 and page requested) | Built | not visually verified |

## Opera-style shell

| Feature | Status | Notes |
|---|---|---|
| Workspace sidebar + web-app shortcuts + side panels | Verified (layout) / Built (panels) | shortcuts use each site's own favicon; no partnerships implied |
| Vertical tabs, compact rail, right side, horizontal, hidden | Verified (layout changes keep pages loaded) | |
| Resizable tab panel | Built | |
| WIISB Clusters (manual + local suggestions) | Verified (logic) / Built (menus) | |
| Workspaces create/edit/delete (asks what to do with tabs)/duplicate/hide/reorder | Verified (logic, switching, moving) / Built (dialogs) | |
| Hover preview cards, recent-tab dots, markers | Built | previews held in memory only |
| Tab search across windows, command bar (Ctrl+K), 116 commands | Verified (commands) / Built (palette window) | |
| Keyboard shortcuts (all required), rebinding with conflicts | Verified (map) / Built (capture dialog) | page-focused shortcuts via engine hook (verified present) |
| Themes: 14 built in + custom, editor, import/export, instant apply | Verified (apply/restore, validation) / Built (editor UI) | |
| Animated new-tab backgrounds, wallpaper, Reduce motion | Built | |
| Onboarding, new-tab page, Speed Dial | Verified (renders, tiles) | |
| Custom title bar with window buttons | Built | **no Windows 11 snap-layout flyout** on the maximize button; snapping by dragging works |

## Privacy & performance

| Feature | Status | Notes |
|---|---|---|
| Ad/tracker blocking, per-site switch, real counters | Verified (rules + real blocked requests) | host-based only; no cosmetic/script/path rules; EasyList is downloaded on demand, not bundled |
| Tracking prevention levels | Built | applied through the engine's own setting |
| Private window isolation | Verified | cookies, history, session, temp folder |
| Site permissions (prompt, remember, revoke) | Verified (prompt + block) / Built (allow, remember) | |
| External protocol links | Built | safe list only, always asks |
| Cookies/site data clearing | Built | per site and per profile |
| Sleeping tabs, never-sleep exceptions, restore scroll | Verified | not for audible/downloading/camera-mic/active tabs |
| WIISB Control (memory, CPU, processes, modes), Gaming mode | Verified (numbers) / Built (mode buttons) | no hard per-tab CPU/RAM limits — by design |
| Proxy setting | Built | a browser proxy, **not a VPN** |

## Tools

| Feature | Status | Notes |
|---|---|---|
| Reader mode, read aloud | Built | read aloud uses installed Windows voices |
| Notes (Markdown preview, export), mini tools | Verified (pages load without errors) | |
| Import bookmarks from Chrome/Edge/Brave/Opera/Vivaldi/Firefox, backup & restore | Built | not run against real browser data |
| Extensions (unpacked folders) | Built | no Web Store, no auto-update; **not tested with a real extension** |
| Default-apps registration (installer) | Verified | does not change the default |

## Not built in 0.1.0

Split-screen browsing · mouse gestures · translation · WIISB Assistant (AI) · cloud sync · VPN · media hub / picture-in-picture
beyond what pages offer · Easy Files · screenshot editing / region / full-page capture · Pinboards/collections UI (the data store
exists) · new-tab widgets with drag layout · Speed Dial folders · PDF annotations · native Windows notifications · jump list and
tray icon · in-app updater (updates are manual: run the new setup) · a password manager UI (the engine's own save/fill works) ·
moving a tab between windows with its history · restoring more than one window per profile · code signing.

## Known issues / honesty notes

* Windows 11 snap layouts do not appear on hover over the custom maximize button.
* The self-test's real-site check needs internet access.
* Websites that reject embedded browsers for sign-in are not worked around; open them in your default browser.
