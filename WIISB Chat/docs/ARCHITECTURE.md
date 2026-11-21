# Architecture

## Desktop

Tauri 2 hosts a React/TypeScript interface in Windows WebView2. Rust owns the tray, single-instance restore and OS credential storage. The native IPC interface accepts only credential-vault operations. System notifications and opt-in autostart use Tauri plugins. The client connects directly to a selected API origin; it contains no database credentials or server signing keys.

`api.ts` handles bearer access tokens in memory, serialized refresh rotation, authenticated media blobs, cancellable upload progress, WebSocket tickets and reconnection. Sensitive refresh data is stored by the Windows credential backend; browser development sessions are memory-only. Nonsecret endpoint/theme preferences use localStorage. Unsent drafts use sessionStorage and are cleared on sign-out. Failed sends retain an explicit Retry action while their conversation remains open; a durable offline outbox is not implemented.

Messages are rendered as escaped Markdown with GFM. Raw HTML is not enabled. External Markdown images are replaced with descriptive text to prevent unrequested tracking requests. Private attachments are fetched with a bearer token and shown as revocable blob URLs. Theme imports accept a small validated JSON schema of colors, sizes and preferences; no CSS or JavaScript evaluation occurs.

## Application server

Fastify modules separate authentication, accounts/social features, communities, permission evaluation, messages, uploads, realtime and media token issuance. Zod validates request input. SQL parameters are bound through Drizzle; SQL identifiers originate only from schema-controlled objects. Production PostgreSQL uses a connection pool. PGlite uses the same PostgreSQL schema in a durable local directory, with serialized transactions.

Numbered SQL migrations are applied transactionally at startup and recorded in `schema_migrations`. Routine startup never resets data. Run only one migration leader/API instance during upgrades; this release has not added a distributed migration lock. Presence, WebSocket routing, rate limits and tickets are process-local, so deploy one API instance. Distributed Redis/pubsub is future work.

## Authentication

Passwords use Argon2id (19 MiB memory, two iterations, one lane). Access JWTs expire in 10 minutes and bind to a server-side session. Sessions last at most 30 days. Every authenticated HTTP request checks revocation, expiry and suspension. Refresh tokens are random opaque values; only SHA-256 hashes are persisted. Rotation marks the previous token used within a transaction. Reuse revokes the session, including the new token chain. Logout invalidates the current session; password changes revoke other devices.

WebSocket clients first obtain a single-use ticket through authenticated HTTP, then open `/v1/events?ticket=...`. Tickets expire in 30 seconds. JWTs and refresh credentials never appear in the WebSocket URL. Heartbeats and session rechecks close dead/revoked connections. Query strings, authorization and secrets are excluded from request logs. Platform admin UUIDs are configured explicitly; public registration grants no platform authority.

## Data and authorization

Users have immutable UUIDs and editable unique handles/display identities. DMs have canonical unordered user-pair keys. Group membership is persisted separately; owner-only membership management and ownership succession are enforced. Friendships are symmetric rows, with constraints and pair-locking for simultaneous requests. Blocks suppress friendship operations and new direct/group interaction.

Community membership is required for all server operations. Owners bypass role checks. Members inherit a union of the default role plus explicitly assigned roles. Private channels require an allowed role in addition to the requested permission. Message, attachment, search and media endpoints use the same evaluator. Management checks enforce role rank and prevent granting permissions the actor lacks. Timeouts suppress send/upload/speak operations. Kicks/bans remove membership; ban records prevent rejoining via invitations. Invitations consume uses transactionally under row locks.

Messages use server UUIDs, timestamps and a client nonce. `(author_id, channel_id, nonce)` prevents duplicate retries. History is cursor-paginated (50 by default, at most 100 per request), while the client currently retains loaded pages rather than virtualizing them. Full-text search uses a GIN index and a required authorized channel scope. Edits preserve previous text in a server-only history table. Current display identities are joined when reading historical messages.

## Realtime protocol v1

Envelope: `{v:1, id, type, resourceId?, at, payload}`. Incoming client events are validated `ping` or `typing` messages. Outgoing events are `ready`, `pong`, `message.created`, `message.updated`, `message.deleted`, `typing`, `presence.changed`, `friends.changed`, `read.changed`, `state.changed`, `notification`, `call.started`, and `error`.

Connection attempts use exponential backoff with jitter capped at 30 seconds. `ready` instructs clients to refetch authoritative lists and visible message history. There is no persisted replay cursor: HTTP resynchronization reconciles missed events. Audience membership/private-channel permissions are reevaluated before broadcasting. Incoming event size/rate and outgoing socket buffering are bounded. Presence considers active connections and the persisted choice; invisible is always published as offline.

## Media and storage

LiveKit OSS provides the actual SFU. The API issues 60-second room-join tokens only after checking membership and connect permission, with permitted microphone/camera/screen sources. Existing room participants have membership and publication permissions reconciled every 15 seconds. Self-hosted LiveKit tokens can remain reusable until expiry; revoked membership can take up to one reconciliation period to remove an existing SFU connection. One participant identity per user means joining the same room from another device can replace the previous media participant.

The client attaches real remote audio/video tracks, publishes user-enabled tracks, handles reconnection, mute/deafen, device selection, local participant volume, focused participant layout, and focused-window push-to-talk. Screen capture uses the runtime's real `getDisplayMedia` through LiveKit. It never substitutes an animation when capture is unsupported. Native screen capture compatibility and system-audio availability remain manual verification items.

Local storage writes random object keys outside the installed program. A private S3-compatible adapter is also implemented. Downloads always pass API authorization; bucket public access is unnecessary. Uploads have configurable per-file/account limits, magic-byte detection, executable/active-content extension denial, safe display filenames and image pixel/decode validation. Image thumbnails are bounded Sharp operations. Video thumbnails/transcoding and malware scanning are not implemented.

Deleting messages/servers/accounts removes relevant attachment rows through foreign keys, denying further downloads immediately. Unreferenced registered objects are garbage-collected after one hour; unsent uploads/replaced profile assets expire after 24 hours. Physical file removal may lag logical deletion. Account deletion anonymizes authorship of retained messages rather than deleting the conversation's entire history. Backups follow the host's separate retention policy. Server-side edit history is retained until its message is deleted. Chat is not end-to-end encrypted.

## Upstream references

- [Tauri Windows packaging](https://v2.tauri.app/distribute/windows-installer/)
- [LiveKit token permissions](https://docs.livekit.io/frontends/reference/tokens-grants/)
- [LiveKit deployment](https://docs.livekit.io/transport/self-hosting/deployment/)
- [LiveKit ports](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
