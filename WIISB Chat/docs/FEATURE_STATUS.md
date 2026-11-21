# Implementation checklist — 0.1.0

Check marks mean implemented and tested as described in TEST_RESULTS.md, not that the entire master brief is complete.

## Implemented core

- [x] Independent Windows Tauri application, original icon, system tray, single-instance restore.
- [x] Actual Windows x64 executable and NSIS installer.
- [x] WIISB Launcher OTHER section and native Chat discovery/launch command; updated launcher builds.
- [x] Fastify backend, Drizzle parameterized database access, durable embedded PostgreSQL and regular PostgreSQL adapter.
- [x] Transactional numbered SQL migrations and relational constraints/indexes.
- [x] Registration/login, Argon2id passwords, short-lived access JWTs, refresh rotation/replay revocation, sessions and logout.
- [x] OS-backed refresh storage in the native application; no frontend plaintext persistent token storage.
- [x] Two-user real HTTP/WebSocket messaging, persistent history after restart, idempotent sends and retry UI.
- [x] Message edit/delete/reply/reactions/pins, paginated history, per-conversation PostgreSQL full-text search.
- [x] Friend request send/accept/reject/cancel/remove, online/all/pending/blocked views and block enforcement.
- [x] Persisted DMs and owner-managed group creation, rename, member addition/removal and leaving.
- [x] Community creation, descriptions, text/voice/announcement/media channels, categories, private roles and slow mode.
- [x] Transactional expiring/limited/revocable invitations, preview and explicit join.
- [x] Roles, default/member permissions, hierarchy checks, owner transfer, community deletion and leaving.
- [x] Server-side kick/ban/unban/timeout APIs, moderation/audit logs, report submission, explicit platform-admin API authorization.
- [x] Real uploads, progress/cancellation, protected downloads, image thumbnails, media playback and download UI.
- [x] MIME/magic-byte and active-extension validation, image decode/pixel limits, per-file/account limits, private storage.
- [x] Local storage adapter, implemented S3-compatible adapter, logical deletion and scheduled object garbage collection.
- [x] Editable display identity, handle, biography, pronouns, status, avatar/banner upload and animated image rendering.
- [x] Nine built-in themes plus custom colors, font sizes, density, reduced motion, named presets and validated import/export.
- [x] Heartbeats, multiple authenticated client sessions, invisible status masking and reconnect resynchronization.
- [x] Keyboard quick switcher, settings shortcut, multiline composer, Unicode emoji picker, Markdown/GFM and clipboard/file uploads.
- [x] Development and production Compose configuration, local scripts, architecture/deployment documentation.
- [x] All implemented normal-user features are free; no payments, subscriptions or paid unlocks.

## Implemented, requiring further environment verification

- [ ] Real LiveKit audio/video client: automated synthetic-track verification and physical-device verification are recorded separately in TEST_RESULTS.md.
- [ ] Native WebView2 microphone/camera permissions and physical device selection/output, including per-user volume.
- [ ] Native screen/window sharing and system audio. Uses actual runtime capture; unsupported environments show an error. No native fallback capture bridge yet.
- [ ] Native Windows notification display/click routing, opt-in autostart and installer/uninstaller behavior on a clean Windows account.
- [ ] Regular PostgreSQL integration and Docker Compose execution; Docker/PostgreSQL binaries were not preinstalled on the development machine.
- [ ] S3 integration against an actual object store.
- [ ] Public deployment, trusted TLS/WSS, WAN messaging, TURN/TLS and restricted-network media.

## Partial features

- [ ] Roles can be edited through the API; the initial settings UI creates/deletes roles and assigns them, but does not yet expose full role editing/default-permission editing.
- [ ] Moderation UI covers kick/ban/one-hour timeout. Unban is available through the authorized API, with a ban-list endpoint; full moderation workflows need UI work.
- [ ] Native notifications currently cover direct/group messages. Full mentions/replies/friend requests/channel preferences and a notification inbox are incomplete.
- [ ] Search is scoped to the current authorized conversation. Backend filters exist; a global cross-community search interface is not implemented.
- [ ] Channel categories/positions are persisted; a drag/reorder channel editor is not complete. Server rail drag ordering is stored locally, without folders or cross-device sync.
- [ ] Unicode emoji and GIF/image upload/playback work. Recent/favorite/searchable emoji, custom server emoji, sticker catalogs and external GIF search are incomplete.
- [ ] Safe Markdown and code blocks work. A full structured rich-text toolbar, mention autocomplete, underline/spoilers and language highlighting need work.
- [ ] Profiles support avatars, animated assets, banner/bio/pronouns/accent. Full gradient/decorations/layout/badge systems are incomplete.
- [ ] Message pages are bounded server-side; the frontend list is not virtualized and retains loaded pages.
- [ ] Failed sends have Retry; queued messages are not persisted as a durable offline outbox across conversation changes/restarts.

## Not implemented

- [ ] Forum posts and threads/follow/archive/tag workflows.
- [ ] Bots, scoped bot credentials, integration management and webhooks.
- [x] Link an email (confirmed by emailed code) and reset a forgotten password by email. Needs SMTP configured on the server; tested with a stand-in mailer and in a headless browser, not yet through a real SMTP provider. Host-only password recovery remains for accounts without a linked email.
- [ ] Email verification at sign-up (an email is optional and only linked from Settings), notification preferences, and other email features.
- [ ] Server icons/banners, welcome/onboarding messages and server asset libraries.
- [ ] Full per-server/channel/DM notification preferences, synchronized notification inbox and incoming-call ringing/acceptance.
- [ ] Global push-to-talk registration, configurable shortcut editor and conflict detection.
- [ ] Native display-capture fallback, high-resolution 1440p/4K capture certification and pop-out/picture-in-picture calls.
- [ ] Video thumbnail/transcode workers, link preview fetch service and malware scanning.
- [ ] Theme background images/transparency and full appearance-layout presets.
- [ ] MFA, administrative dashboard, backup scheduling, distributed presence/pubsub/Redis, service metrics and horizontal scaling.
- [ ] Auto-updater, signed release distribution, deep-link invite registration and extensive localization.

Do not describe this early release as the fully completed Discord-scale platform in the master brief. The source and checklist retain the remaining scope explicitly.
