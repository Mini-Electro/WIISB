CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text NOT NULL,
 display_name text NOT NULL, bio text NOT NULL DEFAULT '', pronouns text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT '', presence text NOT NULL DEFAULT 'online',
 accent text NOT NULL DEFAULT '#8b5cf6', avatar_id uuid, banner_id uuid,
 settings jsonb NOT NULL DEFAULT '{}', suspended boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
 label text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE TABLE refresh_tokens (
 hash text PRIMARY KEY, session_id uuid NOT NULL REFERENCES sessions ON DELETE CASCADE,
 used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE friend_requests (
 sender_id uuid REFERENCES users ON DELETE CASCADE, recipient_id uuid REFERENCES users ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(sender_id,recipient_id), CHECK(sender_id<>recipient_id)
);
CREATE TABLE friendships (
 user_id uuid REFERENCES users ON DELETE CASCADE, friend_id uuid REFERENCES users ON DELETE CASCADE,
 PRIMARY KEY(user_id,friend_id), CHECK(user_id<>friend_id)
);
CREATE TABLE blocks (
 user_id uuid REFERENCES users ON DELETE CASCADE, blocked_id uuid REFERENCES users ON DELETE CASCADE,
 PRIMARY KEY(user_id,blocked_id), CHECK(user_id<>blocked_id)
);
CREATE TABLE communities (
 id uuid PRIMARY KEY, name text NOT NULL, description text NOT NULL DEFAULT '',
 owner_id uuid NOT NULL REFERENCES users, accent text NOT NULL DEFAULT '#8b5cf6',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE members (
 server_id uuid REFERENCES communities ON DELETE CASCADE, user_id uuid REFERENCES users ON DELETE CASCADE,
 timeout_until timestamptz, joined_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(server_id,user_id)
);
CREATE TABLE roles (
 id uuid PRIMARY KEY, server_id uuid NOT NULL REFERENCES communities ON DELETE CASCADE,
 name text NOT NULL, color text NOT NULL DEFAULT '#a78bfa', position integer NOT NULL DEFAULT 1,
 permissions jsonb NOT NULL DEFAULT '[]', is_default boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX one_default_role ON roles(server_id) WHERE is_default;
CREATE TABLE member_roles (
 server_id uuid NOT NULL, user_id uuid NOT NULL, role_id uuid REFERENCES roles ON DELETE CASCADE,
 PRIMARY KEY(server_id,user_id,role_id), FOREIGN KEY(server_id,user_id) REFERENCES members ON DELETE CASCADE
);
CREATE TABLE channels (
 id uuid PRIMARY KEY, server_id uuid REFERENCES communities ON DELETE CASCADE,
 owner_id uuid REFERENCES users ON DELETE SET NULL, name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('text','voice','announcement','media','dm','group')),
 topic text NOT NULL DEFAULT '', category text NOT NULL DEFAULT 'CHANNELS',
 position integer NOT NULL DEFAULT 0, private boolean NOT NULL DEFAULT false,
 allowed_roles jsonb NOT NULL DEFAULT '[]', slow_mode integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE conversation_members (
 channel_id uuid REFERENCES channels ON DELETE CASCADE, user_id uuid REFERENCES users ON DELETE CASCADE,
 PRIMARY KEY(channel_id,user_id)
);
CREATE TABLE direct_pairs (
 pair text PRIMARY KEY, channel_id uuid UNIQUE NOT NULL REFERENCES channels ON DELETE CASCADE
);
CREATE TABLE messages (
 id uuid PRIMARY KEY, channel_id uuid NOT NULL REFERENCES channels ON DELETE CASCADE,
 author_id uuid REFERENCES users ON DELETE SET NULL, content text NOT NULL,
 nonce uuid NOT NULL, reply_id uuid REFERENCES messages ON DELETE SET NULL,
 pinned boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), edited_at timestamptz,
 UNIQUE(author_id,channel_id,nonce)
);
CREATE INDEX messages_page ON messages(channel_id,created_at DESC,id DESC);
CREATE INDEX messages_search ON messages USING gin(to_tsvector('simple',content));
CREATE TABLE message_edits (
 id uuid PRIMARY KEY, message_id uuid REFERENCES messages ON DELETE CASCADE,
 previous_content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reactions (
 message_id uuid REFERENCES messages ON DELETE CASCADE, user_id uuid REFERENCES users ON DELETE CASCADE,
 emoji text NOT NULL, PRIMARY KEY(message_id,user_id,emoji)
);
CREATE TABLE attachments (
 id uuid PRIMARY KEY, channel_id uuid REFERENCES channels ON DELETE CASCADE,
 message_id uuid REFERENCES messages ON DELETE CASCADE, owner_id uuid REFERENCES users ON DELETE CASCADE,
 name text NOT NULL, mime text NOT NULL, size integer NOT NULL, storage_key text NOT NULL,
 thumbnail_key text, kind text NOT NULL DEFAULT 'message', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE read_states (
 channel_id uuid REFERENCES channels ON DELETE CASCADE, user_id uuid REFERENCES users ON DELETE CASCADE,
 read_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(channel_id,user_id)
);
CREATE TABLE invites (
 token text PRIMARY KEY, server_id uuid NOT NULL REFERENCES communities ON DELETE CASCADE,
 creator_id uuid REFERENCES users ON DELETE SET NULL, expires_at timestamptz NOT NULL,
 max_uses integer NOT NULL, uses integer NOT NULL DEFAULT 0, revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE bans (
 server_id uuid REFERENCES communities ON DELETE CASCADE, user_id uuid REFERENCES users ON DELETE CASCADE,
 reason text NOT NULL DEFAULT '', PRIMARY KEY(server_id,user_id)
);
CREATE TABLE audit_logs (
 id uuid PRIMARY KEY, server_id uuid REFERENCES communities ON DELETE CASCADE,
 actor_id uuid REFERENCES users ON DELETE SET NULL, target_id uuid, action text NOT NULL,
 reason text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reports (
 id uuid PRIMARY KEY, reporter_id uuid REFERENCES users ON DELETE SET NULL,
 target_id uuid NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notifications (
 id uuid PRIMARY KEY, user_id uuid REFERENCES users ON DELETE CASCADE,
 channel_id uuid REFERENCES channels ON DELETE CASCADE, kind text NOT NULL, text text NOT NULL,
 read boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
