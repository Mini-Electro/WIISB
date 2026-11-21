# API reference — v1

Except `/health`, `/v1/info`, registration, login, refresh and WebSocket ticket consumption, routes require `Authorization: Bearer <access>`. JSON request errors contain `{code,message}` with an appropriate HTTP status. Username/password registration uses `{username,password,displayName?}`. Message creation requires a unique UUID `nonce` that must be reused when retrying the same send.

| Method / route                               | Action                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| GET `/health`, `/v1/info`                    | Health and protocol/feature configuration                                          |
| POST `/v1/auth/register`, `/v1/auth/login`   | Create account or authenticate                                                     |
| POST `/v1/auth/refresh`                      | Rotate opaque refresh credential                                                   |
| POST `/v1/auth/logout`                       | Revoke current session                                                             |
| POST `/v1/auth/password`                     | Change own password, revoke other sessions                                         |
| GET `/v1/sessions`                           | List own sessions/current ID                                                       |
| DELETE `/v1/sessions/:id`                    | Revoke own session                                                                 |
| DELETE `/v1/account`                         | Delete own account, password required                                              |
| GET/PATCH `/v1/me`                           | Own identity/privacy preferences                                                   |
| GET `/v1/users?q=handle`                     | Allowed user-handle search                                                         |
| GET `/v1/users/:id`                          | Allowed profile/presence                                                           |
| GET/POST `/v1/friends`                       | Lists or send request by username                                                  |
| POST `/v1/friends/:id/accept`                | Accept incoming request                                                            |
| DELETE `/v1/friends/:id`                     | Cancel/reject request or remove friend                                             |
| POST/DELETE `/v1/blocks/:id`                 | Block/unblock                                                                      |
| GET/POST `/v1/conversations`                 | List/create DM or named group                                                      |
| PATCH `/v1/conversations/:id`                | Owner rename/add/remove                                                            |
| POST `/v1/conversations/:id/leave`           | Leave group                                                                        |
| GET/POST `/v1/servers`                       | List/create joined communities                                                     |
| GET/PATCH/DELETE `/v1/servers/:id`           | Read/manage/delete authorized community                                            |
| POST `/v1/servers/:id/leave`, `/transfer`    | Leave or owner transfer                                                            |
| POST `/v1/servers/:id/channels`              | Create authorized channel                                                          |
| PATCH/DELETE `/v1/channels/:id`              | Manage authorized channel                                                          |
| GET/POST `/v1/servers/:id/invites`           | List/manage or create invitation                                                   |
| GET/DELETE `/v1/invites/:token`              | Preview or revoke invitation                                                       |
| POST `/v1/invites/:token/join`               | Explicit transactional join                                                        |
| POST `/v1/servers/:id/roles`                 | Create role                                                                        |
| PATCH/DELETE `/v1/servers/:id/roles/:roleId` | Edit/delete role with hierarchy checks                                             |
| PUT `/v1/servers/:id/members/:userId/roles`  | Assign complete role set                                                           |
| POST `/v1/servers/:id/moderation`            | Kick/ban/unban/timeout with reason                                                 |
| GET `/v1/servers/:id/audit`, `/bans`         | Authorized audit/ban lists                                                         |
| GET/POST `/v1/channels/:id/messages`         | Paginated history or create message                                                |
| PATCH/DELETE `/v1/messages/:id`              | Edit/pin/delete with authorization                                                 |
| PUT `/v1/messages/:id/reactions`             | `{emoji,active}` idempotent reaction                                               |
| POST `/v1/channels/:id/read`                 | Mark read, optional ISO `at`                                                       |
| GET `/v1/search`                             | Required `q` and `channelId`; optional from/before/after/attachment/pinned filters |
| POST `/v1/channels/:id/attachments`          | Multipart file upload                                                              |
| POST `/v1/profile-assets/avatar`, `/banner`  | Multipart profile image upload                                                     |
| GET `/v1/attachments/:id`                    | Authorized binary download, optional `thumbnail=true`                              |
| POST `/v1/realtime-ticket`                   | Single-use 30-second WebSocket ticket                                              |
| GET `/v1/events?ticket=...`                  | WebSocket upgrade                                                                  |
| POST `/v1/voice/:id/token`                   | Authorized short-lived LiveKit room credential                                     |
| POST `/v1/reports`                           | Submit report by immutable target ID/reason                                        |
| GET `/v1/admin/health`                       | Explicit platform-admin aggregate health/report list                               |
| POST `/v1/admin/users/:id/suspend`           | Explicit platform-admin suspension                                                 |

This is a maintained route reference; an automatically generated OpenAPI document is not yet provided. See the Zod route definitions and integration tests for precise request schemas. This API currently has no public bot/webhook credentials.
