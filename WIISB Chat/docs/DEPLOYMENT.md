# Self-hosting

The built client is not a globally hosted service. No public server or domain has been deployed as part of this local build. Internet communication requires a reachable backend operated by you.

## Local development

Use `scripts/Start-LocalServer.ps1` for durable local PostgreSQL without Docker. Optional `scripts/Install-LocalMedia.ps1` and `scripts/Start-LocalMedia.ps1` run checksum-verified LiveKit on Windows. Set the media values in the root `.env` before starting the API. Alternatively, `docker compose -f infrastructure/docker-compose.yml up --build` runs the backend, regular PostgreSQL and LiveKit together. Use only one API on port 4310 at a time.

Development service ports bind to loopback. Another computer cannot reach `127.0.0.1` on your computer through its own loopback address. Never distribute a local URL as a public endpoint.

## Production on a dedicated Linux server

1. Point `chat.example.com` and `rtc.example.com` DNS records to your reachable server. Install Docker Engine and its Compose plugin.
2. Copy `infrastructure/.env.production.example` to `.env.production` at the project root. Generate distinct high-entropy PostgreSQL, JWT and media credentials. URL-encode the password used in `DATABASE_URL`. Use at least 48 random characters for JWT_SECRET and 32 for the LiveKit secret. Do not commit this file.
3. Set APP_DOMAIN and RTC_DOMAIN. The supplied Compose uses Linux host networking for API/Caddy/LiveKit, and publishes PostgreSQL on loopback. It is intended for a dedicated host, where these ports are available.
4. Configure the host/network firewall: HTTPS 443/TCP, certificate issuance 80/TCP, LiveKit ICE 7881/TCP and 50000–50100/UDP, and embedded TURN 3478/UDP. Keep PostgreSQL 5432, API 4310 and media signaling 7880 private/loopback-accessible. The API binds loopback; Caddy proxies to it. Restrict LiveKit signaling 7880 with the host firewall because host networking binds it separately.
5. Run `docker compose --env-file .env.production -f infrastructure/docker-compose.production.yml up -d --build`. Caddy obtains trusted TLS certificates and proxies HTTPS/WebSocket signaling. PostgreSQL must become healthy before the API starts. Migrations run on API startup. Run a single API instance.
6. Check `https://chat.example.com/health` and `/v1/info`. Configure the Windows client's endpoint to `https://chat.example.com`. Register two actual users from separate computers and validate communication, attachment permissions and reconnect behavior.
7. Test media from distinct external networks. Signaling success alone does not prove ICE connectivity or audio/video delivery.

The production Compose is supplied as a deployable template but has not been executed on this machine: Docker is unavailable. Regular PostgreSQL, public TLS/DNS, S3 and WAN media remain deployment verification items.

## TURN and restrictive networks

The production configuration enables LiveKit's built-in TURN over UDP. Networks blocking UDP may need TURN/TLS on a separately reachable address/port with a trusted certificate. Follow the [official LiveKit deployment guide](https://docs.livekit.io/transport/self-hosting/deployment/) and [VM deployment tooling](https://docs.livekit.io/transport/self-hosting/vm/) for certificate handling and TURN/TLS routing. A custom coturn deployment is optional, not a paid service requirement. Do not claim restricted-network compatibility until relay-only tests pass on your host.

## Storage

The `media` volume is private and owned by the application user. Change MAX_UPLOAD_MB and USER_STORAGE_MB based on available disk/bandwidth; these limits apply equally to every account. Also adjust the Caddy request-body maximum if raising upload size (allow multipart overhead).

For S3-compatible storage, set STORAGE_ADAPTER=s3, S3_BUCKET, S3_REGION, optional S3_ENDPOINT, and AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY in the API service environment or a deployment secret store. Keep the bucket private. The API performs authenticated downloads. This adapter's production behavior needs verification against your chosen object store.

## Backups and upgrades

- Back up PostgreSQL with `pg_dump` and test restores using `pg_restore` against a separate database. Back up the media volume or private object bucket at a matching point in time.
- Retain the exact application version/migrations associated with a backup. Never delete a live database to apply a new release.
- Stop API writes during coordinated database/media snapshots where consistency matters. Protect backup credentials and control retention separately from logical in-app deletion.
- Before upgrading, take a tested backup, run the integration suite and deploy one migration/API process. Check `/health` and two-user behavior afterward.
- For the embedded development database, stop the server, then copy its entire `.data/postgres` directory and corresponding media files. Do not open the same embedded directory from multiple processes.

## Operations and administration

Log output goes to the service's stdout/stderr. Compose logs are available through `docker compose ... logs`. Request logs omit authorization bodies and URL query strings. Avoid exposing raw diagnostic logs publicly.

Platform administrators are explicitly configured immutable user UUIDs in ADMIN_USER_IDS. Determine the intended account from your database, configure its ID, and restart the API. No account becomes admin merely by registering first. `/v1/admin/health` exposes aggregate connection/account counts and abuse reports only to these IDs. `/v1/admin/users/:id/suspend` suspends a user. A full administrator dashboard and MFA are future work.

Rotate JWT_SECRET to invalidate access JWTs; existing valid refresh sessions can obtain new access tokens. Revoke server-side sessions to invalidate refresh credentials as well. Rotate LiveKit secrets and PostgreSQL credentials in both their services and the API. Media tokens are short-lived but current media connections require explicit disconnect/permission reconciliation.

### Email and password reset

Users can link an email in Settings → Account and later use "Forgot password?" on the sign-in screen. The server emails an 8-character code (valid 15 minutes, single use, locked after 5 wrong tries); a correct code lets the user choose a new password and signs them out everywhere. The server answers "forgot password" requests identically whether or not an address has an account, and an address is stored only after its owner confirms a code sent to it.

This needs an outgoing mail (SMTP) account. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` (`true` for port 465), `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` in `.env.production` (any provider works: Brevo, Mailgun, Amazon SES, a Gmail app password, your own mail server). `MAIL_FROM` must be an address the provider allows you to send from; set up the provider's SPF/DKIM for your domain or the codes will land in spam. If `SMTP_HOST` or `MAIL_FROM` is empty on a production server, email features switch themselves off: `/v1/info` reports `emailRecovery: false`, the app hides the option, and `/v1/auth/forgot` answers 503. In development (no `NODE_ENV=production`) with no SMTP, emails are printed to the server console so you can try the flow locally. Keep `TRUST_PROXY=true` behind Caddy (the supplied Compose does) so the per-address rate limits on these endpoints apply to each real client rather than to the proxy.

Verify it on your own server before relying on it: link an email on a test account, request a reset from a second device, and confirm the message arrives (and not in spam). The code paths are covered by automated tests with a stand-in mailer; delivery through a real SMTP provider has not been exercised on this machine.

### Recovery without email

Accounts with no linked email (or servers without SMTP) still need the host-only recovery command. It changes a password and revokes sessions, with no hidden master password. Run it with the same environment/database as the API. For an embedded database, stop the API first.
