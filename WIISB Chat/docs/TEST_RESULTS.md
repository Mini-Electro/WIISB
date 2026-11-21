# Verification record — 13 November 2026

## Passed

| Check                                                                   | Evidence                                                                                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend TypeScript and desktop production frontend builds               | `npm run build`, `test-results/build.log`                                                                                                         |
| Windows Rust compilation                                                | `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`                                                                                   |
| Windows executable and NSIS installer generation                        | `npm run package`, `test-results/package.log`                                                                                                     |
| Backend network/persistence/security suite: 13 passed, 0 failed         | `npm test`, `test-results/integration.log`                                                                                                        |
| Browser UI suite: seven real two-client scenarios, no page errors       | `node --import tsx tests/ui.e2e.ts`, `test-results/ui-results.json`, `test-results/ui.log`                                                        |
| Native credential checks: two passed, 0 failed                          | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --offline`, `test-results/native-tests.log`                                         |
| Dependency audit after patching Drizzle ORM                             | npm install reported zero vulnerabilities; final `test-results/audit.json` records the final dependency tree                                      |
| Launcher frontend production build / native Rust check / NSIS packaging | Sibling launcher `chat-launcher-build.log`, `chat-launcher-rust.log`, `chat-launcher-package.log`                                                 |
| Existing launcher regression suite                                      | 32 tests passed in sibling `chat-launcher-tests.log`                                                                                              |
| Native Chat window rendering                                            | Opened the built `WIISB Chat.exe` in WebView2 and visually inspected its sign-in screen and accessibility tree                                    |
| OTHER section launch behavior                                           | Opened the rebuilt WIISB Launcher, observed OTHER → WIISB Chat, clicked its launch button, and observed Chat come to the foreground with no error |

Backend tests use actual HTTP and WebSocket connections, three registered test accounts, and an on-disk PostgreSQL engine. The test suite closes and reopens both server and database, then logs in and verifies prior messages. It does not substitute a React array or mock persistence.

Coverage includes password hashing, duplicate registration, unauthorized requests, login failure, friend request deduplication and acceptance, canonical DMs, live message delivery, nonce retry deduplication, replies, edit authorization, reaction uniqueness, read states, full-text search permissions, invitations/max uses, private roles, unauthorized channel creation, real image upload/download, unshared/private/deleted attachment access, traversal-style filenames, MIME spoof rejection, blocks, group owner/membership enforcement, privilege escalation prevention, kick revocation, physical orphan-object cleanup, refresh rotation/replay revocation, logout and restart persistence.

The UI suite registers two users through the actual forms, sends/accepts a friend request, exchanges real-time DMs, edits profile status, switches themes, joins a real local LiveKit room, receives video frames, tests microphone mute and remote audio deafening, creates/joins a community via invitation preview, exchanges a community message, and checks a 1024×720 layout and keyboard switcher.

The media test uses Chromium's explicitly generated camera/microphone streams. It verifies real network transport through LiveKit and nonzero decoded video dimensions in the second client. **It does not prove your physical webcam/microphone, Windows WebView2 capture permissions, or audible output work.** It never silently captures the real desktop. Evidence screenshots are `test-results/live-media.png`, `test-results/community.png`, and `test-results/desktop-1024.png`.

The native credential test creates a uniquely named nonsecret Windows Credential Manager entry, reads it through a new entry handle, verifies persistence and deletes only that generated entry. It does not inspect or modify unrelated credentials.

## Remaining manual/environment checks

- [ ] Install/uninstall on a clean Windows user profile; verify Start Menu/desktop shortcut choices, WebView2 bootstrap and preservation/deletion of user data.
- [ ] Register/login/logout/reopen in the packaged native app with real accounts; verify vault restoration, session revocation and the Windows notification permission flow.
- [ ] Verify Windows notifications and click routing while the app is backgrounded. The upstream plugin reports Windows clicks while toasts are on screen; Action Center click behavior is limited.
- [ ] Verify autostart after Windows sign-in and tray behavior across monitor/DPI changes.
- [ ] Use two physical Windows computers, real microphones/speakers/cameras, mute/deafen, output selection, participant volume and focused push-to-talk.
- [ ] Explicitly select a screen/window to share in native WebView2; verify live frames arrive, hidden windows are not included unexpectedly, stop works immediately and system audio behaves as advertised by the chosen runtime.
- [ ] Test packet loss, long disconnections, media reconnection and restricted-network/TURN relay operation.
- [ ] Run the supplied Docker stacks and regular PostgreSQL adapter against a real PostgreSQL service.
- [ ] Validate S3-compatible storage, backups/restores, TLS and public DNS on the chosen host.
- [ ] Deploy and test accounts/messages/media from separate internet networks. No public deployment was performed here.
- [ ] Load/security review for a public service. The passing functional suite is not a comprehensive security audit.

## Resolved during verification

- Pinned ORM range initially included a known identifier-escaping advisory; upgraded to patched Drizzle 0.45.4 and audited again.
- A shutdown race allowed presence callbacks to query a closing database; added explicit realtime shutdown before database teardown and verified restart persistence.
- Development Vite binding differed from the test origin; explicitly bound it to IPv4 loopback.
- Form help text polluted input accessible names; connected labels and descriptions separately and named modal dialogs.
- Remote volume reset on speaker events could override per-participant volume; deafen now mutes the attached audio elements independently, with a browser test.

See FEATURE_STATUS.md for unimplemented features. Passing these checks does not make this early release the entire requested Discord-scale specification.
