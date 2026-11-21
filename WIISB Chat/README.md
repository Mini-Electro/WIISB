# WIISB Chat

A Windows desktop client and self-hostable communication server. All implemented features are available to every account, without subscriptions or payment details.

**This is version 0.1.0, an early working release.** It implements real accounts, persistent direct/group/community messaging, friendship management, file sharing, roles, private channels, and a LiveKit media client. It does not yet implement every item in the supplied master brief. Read [feature status](docs/FEATURE_STATUS.md) for the exact remaining work and verification limits.

## Windows application

The release copies are in `release/`:

- `WIISB Chat.exe` — standalone Windows x64 executable. Windows WebView2 is required.
- `WIISB Chat_0.1.0_x64-setup.exe` — per-user NSIS installer, with Start Menu integration and WebView2 bootstrap support.

These are unsigned builds. The installer does not include a publicly hosted chat server. Install the client, run your own backend or obtain your host's HTTPS address, then choose that address on the sign-in screen. Accounts are specific to the selected host.

Closing the desktop window keeps Chat in the system tray. Choose **Quit** from the tray to exit. The Windows Credential Manager stores the rotating refresh credential; long-lived credentials are never saved in frontend localStorage. The browser development client keeps authentication in memory and requires signing in after a reload.

## WIISB Launcher

The sibling `../WIISB Launcher` project now has **OTHER → WIISB Chat**. It uses a native fixed-purpose launch command, discovers the installed app from its uninstall registration/default local installation folder, and falls back to this project's release executable during development. Chat remains an independent application.

Use the rebuilt launcher executable/installer to see the new section; an older running launcher keeps its existing UI until replaced/restarted.

## Start locally on Windows

Requirements: Node.js 24+, npm, Windows 10/11, WebView2. Rust and Visual Studio C++ Build Tools are needed only to rebuild the native client.

From this project folder:

```powershell
npm install
npm run build
# Optional: copy .env.example to .env and edit it.
.\scripts\Start-LocalServer.ps1
```

The server listens on `http://127.0.0.1:4310`. Without `DATABASE_URL`, it uses persistent embedded PostgreSQL through PGlite. The start script puts data in `.data/`, outside the installed client. Keep this terminal/service running while using the local client. Open `release\WIISB Chat.exe` or use the launcher, then register your own account. No predefined users or mock conversations are installed.

For voice/video, run these in a second terminal:

```powershell
.\scripts\Install-LocalMedia.ps1
.\scripts\Start-LocalMedia.ps1
```

The download script verifies the official release's SHA-256 checksum. Set the local-only values from `.env.example` (`LIVEKIT_URL=ws://127.0.0.1:7880`, `LIVEKIT_API_KEY=devkey`, `LIVEKIT_API_SECRET=secret`) in your root `.env`, then restart the application server. These credentials must never be used on a public host. Media capture starts only after joining a call; camera and screen capture each require their own action.

Embedded PostgreSQL is for one local API process. Production uses an ordinary PostgreSQL server. Docker is not required to run the packaged desktop client or the local embedded database.

## Development and builds

```powershell
npm run server        # backend development watcher; loads apps/server/.env by default
npm run dev           # React development client at http://127.0.0.1:1432
npm run desktop       # native Tauri development client; backend runs separately
npm run build         # TypeScript server + frontend production builds
npm test              # real HTTP/WebSocket/PostgreSQL integration suite
npm run package       # compile the Windows client + NSIS installer
.\scripts\Package.ps1 # build and copy final executables into release/
```

When using npm workspace server commands, set `DOTENV_CONFIG_PATH` to the root `.env` or put a separate `.env` inside `apps/server`. For a compiled backend, use `scripts/Start-LocalServer.ps1` locally or `node apps/server/dist/main.js` with service environment variables.

The UI test is `node --import tsx tests/ui.e2e.ts`. First install Chromium with `npx playwright install chromium`, stop other API/Vite instances on 4310/1432, and run the local LiveKit server on 7880. It uses isolated test databases and generated media tracks; it does not activate your actual webcam or microphone.

## Self-hosting

Local Compose: `docker compose -f infrastructure/docker-compose.yml up --build`. This includes PostgreSQL, API, and LiveKit with loopback-only development ports.

For internet users, deploy on a reachable server with DNS, trusted HTTPS/WSS, PostgreSQL, private file storage, and reachable LiveKit media ports. Configure each Windows client with the host's HTTPS origin. See [deployment](docs/DEPLOYMENT.md) and [architecture](docs/ARCHITECTURE.md). Hosting, traffic, TURN relay and storage can cost money; there are no mandatory software subscription services.

## Source and records

| Item                             | Location                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| Desktop React code               | `apps/desktop/src/`                                                                  |
| Native Rust code                 | `apps/desktop/src-tauri/`                                                            |
| API source / compiled API        | `apps/server/src/` / `apps/server/dist/`                                             |
| Database migrations              | `apps/server/migrations/`                                                            |
| Development / production Compose | `infrastructure/docker-compose.yml` / `infrastructure/docker-compose.production.yml` |
| Environment example              | `.env.example`                                                                       |
| Deployment environment example   | `infrastructure/.env.production.example`                                             |
| Feature checklist                | `docs/FEATURE_STATUS.md`                                                             |
| Test evidence                    | `docs/TEST_RESULTS.md`, `test-results/`                                              |

## Troubleshooting

- **Unable to connect:** start the backend, check `/health`, then verify the selected origin. Remote HTTP addresses are rejected; use HTTPS. Local HTTP is restricted to loopback.
- **Voice unavailable:** the host must configure LiveKit. Text chat continues to work without it. Check media-server logs and token authorization separately.
- **Account recovery:** if the server has SMTP configured (see docs/DEPLOYMENT.md) users can link an email in Settings → Account and use "Forgot password?" to reset by emailed code. For accounts without a linked email, or servers without SMTP, on the server host, use `npm run recover -w @wiisb/server -- username`, with the same database/data environment. Stop an embedded-database API process before using recovery. It changes the password and revokes every session. The local recovery prompt explicitly warns that input is visible.
- **Session expired:** sign in again. Refresh-token replay revokes that entire session; changing a password revokes the other devices.
- **No Chat launcher entry:** run the rebuilt WIISB Launcher. If Chat is not detected, install Chat or keep `release\WIISB Chat.exe` at this project's release path.
- **No physical device / screen capture:** capture must be supported by the actual Windows/WebView2 environment. Device-denied or unsupported capture produces an explicit error. Physical hardware and native screen capture require the manual tests in the test record.
