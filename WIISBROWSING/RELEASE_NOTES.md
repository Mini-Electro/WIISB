# WIISBROWSING 0.1.0 — first milestone

A real, installable Windows browser on the Chromium engine. See README.md for what it does and docs/FEATURES.md for the exact
status of every feature (including what is **not** built yet).

## Highlights

* Vertical tabs (default) with workspaces, clusters, pinned tabs, drag-reorder, hover previews and sleeping tabs
* Ctrl+K command bar, full shortcut set, omnibox with real suggestions
* Ad/tracker blocking with real counters, tracking prevention, private windows with isolated storage, profiles
* Downloads, history, bookmarks, session restore, themes, new-tab page, reader mode, notes, WIISB Control

## Verified on this build

* 102 unit tests pass
* 30 end-to-end checks pass on the published build (and 29 earlier on the installed copy): real HTTPS sites, a real download,
  popups, permission prompts, ad blocking, tab sleep/wake with scroll restore, private-window isolation, session restore in a new process
* Installer: silent install, uninstall and clean-up checked; default browser left unchanged

## Bugs the end-to-end test found and fixed during development

* Downloads to a folder path containing `..` never started → paths are normalised
* Capturing a preview of a hidden page hangs the engine → captures only visible pages, with a time-out
* Theme animation crashed because WPF freezes application-level brushes → frame-stepped colour tween
* A superseded ("aborted") navigation could put an error page over a working site → only the current navigation can fail a page
* A second window could overwrite the saved session → only the first window of a profile owns it
* The wiisb:// bridge replied with string ids the pages couldn't match → fixed; settings pages now load
* The connection to the database leaked when opening failed (file stayed locked) → disposed on failure

## Known limitations

See docs/FEATURES.md → *Not built in 0.1.0* and *Known issues*. Notably: no split-screen, no mouse gestures, no translation,
no AI assistant, no sync, no VPN (proxy only), no Windows 11 snap-layout flyout on the maximize button, unsigned installer.
