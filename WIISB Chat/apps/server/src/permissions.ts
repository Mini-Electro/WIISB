import type { Query } from "./db.js";
import { fail, type Permission } from "./core.js";
export async function serverPermissions(db: Query, uid: string, sid: string) {
  const [server] = await db.query("SELECT * FROM communities WHERE id=$1", [
    sid,
  ]);
  if (!server) fail("not_found", "Community not found.", 404);
  const [member] = await db.query(
    "SELECT * FROM members WHERE server_id=$1 AND user_id=$2",
    [sid, uid],
  );
  if (!member)
    fail("forbidden", "You are not a member of this community.", 403);
  const roles = await db.query(
    `SELECT r.* FROM roles r WHERE r.server_id=$1 AND (r.is_default OR r.id IN (SELECT role_id FROM member_roles WHERE server_id=$1 AND user_id=$2))`,
    [sid, uid],
  );
  return {
    server,
    member,
    owner: server.owner_id === uid,
    roles,
    permissions: new Set<string>(roles.flatMap((r) => r.permissions)),
    position: Math.max(0, ...roles.map((r) => r.position)),
  };
}
export async function requireServer(
  db: Query,
  uid: string,
  sid: string,
  permission: Permission,
) {
  const access = await serverPermissions(db, uid, sid);
  if (!access.owner && !access.permissions.has(permission))
    fail(
      "forbidden",
      `You need the ${permission.replaceAll("_", " ")} permission.`,
      403,
    );
  return access;
}
export async function requireChannel(
  db: Query,
  uid: string,
  cid: string,
  permission: Permission = "view",
) {
  const [channel] = await db.query("SELECT * FROM channels WHERE id=$1", [cid]);
  if (!channel) fail("not_found", "Conversation not found.", 404);
  if (channel.server_id) {
    const access = await serverPermissions(db, uid, channel.server_id);
    if (
      !access.owner &&
      (!access.permissions.has("view") ||
        !access.permissions.has(permission) ||
        (channel.private &&
          !access.roles.some((r) => channel.allowed_roles.includes(r.id))))
    )
      fail("forbidden", "You cannot access this channel.", 403);
    if (
      ["send", "attach", "speak"].includes(permission) &&
      access.member.timeout_until &&
      new Date(access.member.timeout_until) > new Date()
    )
      fail("timeout", "You are temporarily timed out.", 403);
    if (
      channel.kind === "announcement" &&
      permission === "send" &&
      !access.owner &&
      !access.permissions.has("manage_messages")
    )
      fail("forbidden", "Only moderators can post announcements.", 403);
  } else {
    if (
      !(
        await db.query(
          "SELECT 1 FROM conversation_members WHERE channel_id=$1 AND user_id=$2",
          [cid, uid],
        )
      ).length
    )
      fail("forbidden", "You are not in this conversation.", 403);
    if (
      permission !== "view" &&
      (
        await db.query(
          `SELECT 1 FROM conversation_members cm JOIN blocks b ON (b.user_id=cm.user_id AND b.blocked_id=$2) OR (b.blocked_id=cm.user_id AND b.user_id=$2) WHERE cm.channel_id=$1`,
          [cid, uid],
        )
      ).length
    )
      fail("blocked", "Interaction is unavailable in this conversation.", 403);
  }
  return channel;
}
export async function channelAudience(db: Query, cid: string) {
  const [channel] = await db.query("SELECT * FROM channels WHERE id=$1", [cid]);
  if (!channel) return [];
  const rows = channel.server_id
    ? await db.query("SELECT user_id FROM members WHERE server_id=$1", [
        channel.server_id,
      ])
    : await db.query(
        "SELECT user_id FROM conversation_members WHERE channel_id=$1",
        [cid],
      );
  const allowed: string[] = [];
  for (const row of rows) {
    try {
      await requireChannel(db, row.user_id, cid);
      allowed.push(row.user_id);
    } catch {}
  }
  return allowed;
}
