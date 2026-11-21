import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  body,
  params,
  id,
  blocked,
  fail,
  name,
  publicUser,
  type Services,
} from "./core.js";
import { requireChannel } from "./permissions.js";

export async function socialRoutes(
  app: FastifyInstance,
  { db, hub }: Services,
) {
  app.get(
    "/v1/me",
    async (req) =>
      (
        await db.query(
          `SELECT ${publicUser},settings,presence FROM users WHERE id=$1`,
          [req.identity.uid],
        )
      )[0],
  );
  app.patch("/v1/me", async (req) => {
    const data = body(
      req,
      z.object({
        display_name: name.optional(),
        username: z
          .string()
          .regex(/^[a-z0-9_]{3,32}$/)
          .optional(),
        bio: z.string().max(1000).optional(),
        pronouns: z.string().max(40).optional(),
        status: z.string().max(140).optional(),
        presence: z.enum(["online", "idle", "dnd", "invisible"]).optional(),
        accent: z
          .string()
          .regex(/^#[\da-fA-F]{6}$/)
          .optional(),
        // How the avatar and banner pictures are framed (zoom, focal point in %, banner height in px).
        avatar_zoom: z.number().min(1).max(4).optional(),
        avatar_x: z.number().min(0).max(100).optional(),
        avatar_y: z.number().min(0).max(100).optional(),
        banner_zoom: z.number().min(1).max(4).optional(),
        banner_x: z.number().min(0).max(100).optional(),
        banner_y: z.number().min(0).max(100).optional(),
        banner_height: z.number().int().min(60).max(220).optional(),
        settings: z
          .object({
            dmPolicy: z.enum(["friends", "everyone", "none"]).optional(),
            friendRequests: z.boolean().optional(),
            notifications: z.boolean().optional(),
          })
          .optional(),
      }),
    );
    for (const [column, value] of Object.entries(data))
      await db.query(`UPDATE users SET ${column}=$1 WHERE id=$2`, [
        column === "settings" ? JSON.stringify(value) : value,
        req.identity.uid,
      ]);
    await hub.presence(req.identity.uid);
    hub.send([req.identity.uid], "state.changed", {});
    return (
      await db.query(
        `SELECT ${publicUser},settings,presence FROM users WHERE id=$1`,
        [req.identity.uid],
      )
    )[0];
  });
  app.get("/v1/users", async (req) => {
    const { q } = z.object({ q: z.string().min(2).max(32) }).parse(req.query);
    const rows = await db.query(
      `SELECT ${publicUser} FROM users u WHERE username ILIKE $1 AND id<>$2 AND NOT suspended AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.user_id=$2 AND b.blocked_id=u.id) OR (b.blocked_id=$2 AND b.user_id=u.id)) ORDER BY username LIMIT 20`,
      [q.replace(/[%_\\]/g, "\\$&") + "%", req.identity.uid],
    );
    return rows;
  });
  app.get("/v1/users/:id", async (req) => {
    const uid = z.uuid().parse(params(req).id);
    if (await blocked(db, uid, req.identity.uid))
      fail("forbidden", "This profile is unavailable.", 403);
    const [user] = await db.query(
      `SELECT ${publicUser},presence FROM users WHERE id=$1`,
      [uid],
    );
    if (!user) fail("not_found", "User not found.", 404);
    const related =
      uid === req.identity.uid ||
      (
        await db.query(
          `SELECT 1 FROM friendships WHERE user_id=$1 AND friend_id=$2 UNION SELECT 1 FROM members m JOIN members n ON n.server_id=m.server_id WHERE m.user_id=$1 AND n.user_id=$2`,
          [uid, req.identity.uid],
        )
      ).length > 0;
    return {
      ...user,
      presence: related ? hub.status(uid, user.presence) : "offline",
    };
  });
  app.get("/v1/friends", async (req) => {
    const uid = req.identity.uid;
    const friends = await db.query(
      `SELECT u.id,u.username,u.display_name,u.avatar_id,u.avatar_zoom,u.avatar_x,u.avatar_y,u.status,u.presence FROM users u JOIN friendships f ON f.friend_id=u.id WHERE f.user_id=$1 ORDER BY u.display_name`,
      [uid],
    );
    const incoming = await db.query(
      "SELECT u.id,u.username,u.display_name,u.avatar_id,u.avatar_zoom,u.avatar_x,u.avatar_y FROM users u JOIN friend_requests f ON f.sender_id=u.id WHERE f.recipient_id=$1",
      [uid],
    );
    const outgoing = await db.query(
      "SELECT u.id,u.username,u.display_name,u.avatar_id,u.avatar_zoom,u.avatar_x,u.avatar_y FROM users u JOIN friend_requests f ON f.recipient_id=u.id WHERE f.sender_id=$1",
      [uid],
    );
    const blocks = await db.query(
      "SELECT u.id,u.username,u.display_name,u.avatar_id,u.avatar_zoom,u.avatar_x,u.avatar_y FROM users u JOIN blocks b ON b.blocked_id=u.id WHERE b.user_id=$1",
      [uid],
    );
    return {
      friends: friends.map((u) => ({
        ...u,
        presence: hub.status(u.id, u.presence),
      })),
      incoming,
      outgoing,
      blocked: blocks,
    };
  });
  app.post("/v1/friends", async (req) => {
    const { username } = body(
      req,
      z.object({ username: z.string().trim().toLowerCase().max(32) }),
    );
    const uid = req.identity.uid;
    const [target] = await db.query(
      "SELECT id,settings FROM users WHERE username=$1 AND NOT suspended",
      [username],
    );
    if (
      !target ||
      target.id === uid ||
      (await blocked(db, uid, target.id)) ||
      target.settings.friendRequests === false
    )
      fail("unavailable", "Unable to send a request to this user.");
    await db.transaction(async (tx) => {
      await tx.query(
        "SELECT id FROM users WHERE id=$1 OR id=$2 ORDER BY id FOR UPDATE",
        [uid, target.id],
      );
      if (await blocked(tx, uid, target.id))
        fail("unavailable", "Unable to send a request to this user.");
      if (
        (
          await tx.query(
            "SELECT 1 FROM friendships WHERE user_id=$1 AND friend_id=$2",
            [uid, target.id],
          )
        ).length
      )
        fail("already_friends", "You are already friends.", 409);
      if (
        (
          await tx.query(
            "SELECT 1 FROM friend_requests WHERE sender_id=$1 AND recipient_id=$2",
            [target.id, uid],
          )
        ).length
      ) {
        await tx.query(
          "INSERT INTO friendships(user_id,friend_id) VALUES($1,$2),($2,$1) ON CONFLICT DO NOTHING",
          [uid, target.id],
        );
        await tx.query(
          "DELETE FROM friend_requests WHERE (sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1)",
          [uid, target.id],
        );
      } else
        await tx.query(
          "INSERT INTO friend_requests(sender_id,recipient_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [uid, target.id],
        );
    });
    hub.send([uid, target.id], "friends.changed", {});
    return { ok: true };
  });
  app.post("/v1/friends/:id/accept", async (req) => {
    const target = z.uuid().parse(params(req).id),
      uid = req.identity.uid;
    await db.transaction(async (tx) => {
      if (await blocked(tx, uid, target))
        fail("unavailable", "Interaction is unavailable.", 403);
      if (
        !(
          await tx.query(
            "DELETE FROM friend_requests WHERE sender_id=$1 AND recipient_id=$2 RETURNING sender_id",
            [target, uid],
          )
        ).length
      )
        fail("not_found", "Friend request not found.", 404);
      await tx.query(
        "INSERT INTO friendships(user_id,friend_id) VALUES($1,$2),($2,$1) ON CONFLICT DO NOTHING",
        [uid, target],
      );
    });
    hub.send([uid, target], "friends.changed", {});
    return { ok: true };
  });
  app.delete("/v1/friends/:id", async (req) => {
    const target = z.uuid().parse(params(req).id),
      uid = req.identity.uid;
    await db.transaction(async (tx) => {
      await tx.query(
        "DELETE FROM friendships WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)",
        [uid, target],
      );
      await tx.query(
        "DELETE FROM friend_requests WHERE (sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1)",
        [uid, target],
      );
    });
    hub.send([uid, target], "friends.changed", {});
    return { ok: true };
  });
  app.post("/v1/blocks/:id", async (req) => {
    const target = z.uuid().parse(params(req).id),
      uid = req.identity.uid;
    if (target === uid) fail("invalid", "You cannot block yourself.");
    await db.transaction(async (tx) => {
      await tx.query(
        "SELECT id FROM users WHERE id=$1 OR id=$2 ORDER BY id FOR UPDATE",
        [uid, target],
      );
      await tx.query(
        "INSERT INTO blocks(user_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [uid, target],
      );
      await tx.query(
        "DELETE FROM friendships WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)",
        [uid, target],
      );
      await tx.query(
        "DELETE FROM friend_requests WHERE (sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1)",
        [uid, target],
      );
    });
    hub.send([uid, target], "friends.changed", {});
    return { ok: true };
  });
  app.delete("/v1/blocks/:id", async (req) => {
    await db.query("DELETE FROM blocks WHERE user_id=$1 AND blocked_id=$2", [
      req.identity.uid,
      z.uuid().parse(params(req).id),
    ]);
    hub.send([req.identity.uid], "friends.changed", {});
    return { ok: true };
  });
  app.get("/v1/conversations", async (req) => {
    const rows = await db.query(
      `SELECT c.*, (SELECT count(*)::int FROM messages msg WHERE msg.channel_id=c.id AND msg.author_id<>$1 AND msg.created_at>coalesce((SELECT read_at FROM read_states r WHERE r.channel_id=c.id AND r.user_id=$1),'1970-01-01'::timestamptz)) AS unread FROM channels c JOIN conversation_members cm ON cm.channel_id=c.id WHERE cm.user_id=$1 ORDER BY (SELECT max(created_at) FROM messages WHERE channel_id=c.id) DESC NULLS LAST`,
      [req.identity.uid],
    );
    for (const row of rows)
      row.members = await db.query(
        "SELECT u.id,u.username,u.display_name,u.avatar_id,u.avatar_zoom,u.avatar_x,u.avatar_y FROM users u JOIN conversation_members cm ON cm.user_id=u.id WHERE cm.channel_id=$1",
        [row.id],
      );
    return rows;
  });
  app.post("/v1/conversations", async (req) => {
    const { users, name: label } = body(
      req,
      z.object({
        users: z.array(z.uuid()).min(1).max(19),
        name: name.optional(),
      }),
    );
    const uid = req.identity.uid;
    const members = [...new Set([uid, ...users])];
    if (members.length < 2) fail("invalid", "Choose another participant.");
    for (const target of members.filter((u) => u !== uid)) {
      if (await blocked(db, uid, target))
        fail("unavailable", "Interaction is unavailable.", 403);
      const [user] = await db.query(
        "SELECT settings FROM users WHERE id=$1 AND NOT suspended",
        [target],
      );
      if (!user) fail("not_found", "User unavailable.", 404);
      const friend = (
        await db.query(
          "SELECT 1 FROM friendships WHERE user_id=$1 AND friend_id=$2",
          [uid, target],
        )
      ).length;
      if (
        user.settings.dmPolicy === "none" ||
        (!friend && user.settings.dmPolicy !== "everyone")
      )
        fail("privacy", "This user only accepts messages from friends.", 403);
    }
    const channel = await db.transaction(async (tx) => {
      const isGroup = label !== undefined || members.length > 2;
      const pair = !isGroup ? members.toSorted().join(":") : null;
      if (pair) {
        await tx.query(
          "SELECT id FROM users WHERE id=$1 OR id=$2 ORDER BY id FOR UPDATE",
          members,
        );
        const [existing] = await tx.query(
          "SELECT c.* FROM direct_pairs d JOIN channels c ON c.id=d.channel_id WHERE pair=$1",
          [pair],
        );
        if (existing) return existing;
      }
      const cid = id();
      const [row] = await tx.query(
        "INSERT INTO channels(id,owner_id,name,kind) VALUES($1,$2,$3,$4) RETURNING *",
        [cid, uid, label || "Conversation", isGroup ? "group" : "dm"],
      );
      for (const user of members)
        await tx.query(
          "INSERT INTO conversation_members(channel_id,user_id) VALUES($1,$2)",
          [cid, user],
        );
      if (pair)
        await tx.query(
          "INSERT INTO direct_pairs(pair,channel_id) VALUES($1,$2)",
          [pair, cid],
        );
      return row;
    });
    hub.send(members, "state.changed", {});
    return channel;
  });
  app.patch("/v1/conversations/:id", async (req) => {
    const cid = z.uuid().parse(params(req).id),
      uid = req.identity.uid;
    const channel = await requireChannel(db, uid, cid);
    if (channel.kind !== "group" || channel.owner_id !== uid)
      fail("forbidden", "Only the group owner can manage participants.", 403);
    const data = body(
      req,
      z.object({
        name: name.optional(),
        add: z.uuid().optional(),
        remove: z.uuid().optional(),
      }),
    );
    if (data.name)
      await db.query("UPDATE channels SET name=$1 WHERE id=$2", [
        data.name,
        cid,
      ]);
    if (data.add) {
      if (
        (await blocked(db, uid, data.add)) ||
        !(
          await db.query(
            "SELECT 1 FROM friendships WHERE user_id=$1 AND friend_id=$2",
            [uid, data.add],
          )
        ).length
      )
        fail("privacy", "You can only add your friends.", 403);
      if (
        (
          await db.query(
            "SELECT 1 FROM conversation_members WHERE channel_id=$1",
            [cid],
          )
        ).length >= 20
      )
        fail("limit", "Groups support up to 20 participants.");
      await db.query(
        "INSERT INTO conversation_members(channel_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [cid, data.add],
      );
    }
    if (data.remove && data.remove !== uid)
      await db.query(
        "DELETE FROM conversation_members WHERE channel_id=$1 AND user_id=$2",
        [cid, data.remove],
      );
    await hub.channel(cid, "state.changed", {});
    if (data.remove) hub.send([data.remove], "state.changed", {});
    return { ok: true };
  });
  app.post("/v1/conversations/:id/leave", async (req) => {
    const cid = z.uuid().parse(params(req).id),
      uid = req.identity.uid;
    const channel = await requireChannel(db, uid, cid);
    if (channel.kind !== "group") fail("invalid", "Only groups can be left.");
    await db.transaction(async (tx) => {
      await tx.query(
        "DELETE FROM conversation_members WHERE channel_id=$1 AND user_id=$2",
        [cid, uid],
      );
      const remaining = await tx.query(
        "SELECT user_id FROM conversation_members WHERE channel_id=$1 ORDER BY user_id",
        [cid],
      );
      if (!remaining.length)
        await tx.query("DELETE FROM channels WHERE id=$1", [cid]);
      else if (channel.owner_id === uid)
        await tx.query("UPDATE channels SET owner_id=$1 WHERE id=$2", [
          remaining[0].user_id,
          cid,
        ]);
    });
    await hub.channel(cid, "state.changed", {});
    hub.send([uid], "state.changed", {});
    return { ok: true };
  });
}
