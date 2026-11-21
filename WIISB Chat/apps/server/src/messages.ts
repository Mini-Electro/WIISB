import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { body, params, id, fail, type Services } from "./core.js";
import {
  requireChannel,
  requireServer,
  channelAudience,
} from "./permissions.js";
import type { Query } from "./db.js";
export async function messageView(db: Query, mid: string) {
  const [message] = await db.query(
    "SELECT m.*,u.username,u.display_name,u.avatar_id,u.avatar_zoom,u.avatar_x,u.avatar_y FROM messages m LEFT JOIN users u ON u.id=m.author_id WHERE m.id=$1",
    [mid],
  );
  if (!message) return null;
  message.attachments = await db.query(
    "SELECT id,name,mime,size,thumbnail_key IS NOT NULL AS thumbnail FROM attachments WHERE message_id=$1",
    [mid],
  );
  message.reactions = await db.query(
    "SELECT emoji,array_agg(user_id) AS users FROM reactions WHERE message_id=$1 GROUP BY emoji",
    [mid],
  );
  if (message.reply_id)
    message.reply = (
      await db.query(
        "SELECT m.id,m.content,u.display_name FROM messages m LEFT JOIN users u ON u.id=m.author_id WHERE m.id=$1",
        [message.reply_id],
      )
    )[0];
  return message;
}
export async function messageRoutes(
  app: FastifyInstance,
  { db, hub }: Services,
) {
  app.get("/v1/channels/:id/messages", async (req) => {
    const cid = z.uuid().parse(params(req).id);
    await requireChannel(db, req.identity.uid, cid);
    const q = z
      .object({
        before: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        pinned: z.enum(["true", "false"]).optional(),
      })
      .parse(req.query);
    let cursor: any;
    if (q.before) {
      [cursor] = await db.query(
        "SELECT created_at,id FROM messages WHERE id=$1 AND channel_id=$2",
        [q.before, cid],
      );
      if (!cursor) fail("invalid_cursor", "Message cursor not found.");
    }
    const rows = await db.query(
      `SELECT id FROM messages WHERE channel_id=$1 ${cursor ? "AND (created_at,id)<($3::timestamptz,$4::uuid)" : ""} ${q.pinned === "true" ? "AND pinned" : ""} ORDER BY created_at DESC,id DESC LIMIT $2`,
      cursor ? [cid, q.limit, cursor.created_at, cursor.id] : [cid, q.limit],
    );
    const messages = [];
    for (const r of rows.toReversed())
      messages.push(await messageView(db, r.id));
    return { messages, hasMore: rows.length === q.limit };
  });
  app.post("/v1/channels/:id/messages", async (req) => {
    const cid = z.uuid().parse(params(req).id),
      uid = req.identity.uid;
    const data = body(
      req,
      z.object({
        content: z.string().max(8000).default(""),
        nonce: z.uuid(),
        replyId: z.uuid().optional(),
        attachments: z.array(z.uuid()).max(10).default([]),
      }),
    );
    if (!data.content.trim() && !data.attachments.length)
      fail("empty", "Write a message or attach a file.");
    const result = await db.transaction(async (tx) => {
      const c = await requireChannel(tx, uid, cid, "send");
      await tx.query("SELECT id FROM channels WHERE id=$1 FOR UPDATE", [cid]);
      const [existing] = await tx.query(
        "SELECT id FROM messages WHERE author_id=$1 AND channel_id=$2 AND nonce=$3",
        [uid, cid, data.nonce],
      );
      if (existing) return { id: existing.id, created: false };
      if (c.slow_mode) {
        const [last] = await tx.query(
          "SELECT created_at FROM messages WHERE author_id=$1 AND channel_id=$2 ORDER BY created_at DESC LIMIT 1",
          [uid, cid],
        );
        if (
          last &&
          Date.now() - new Date(last.created_at).getTime() < c.slow_mode * 1000
        )
          fail("slow_mode", `Slow mode is ${c.slow_mode} seconds.`, 429);
      }
      if (
        data.replyId &&
        !(
          await tx.query(
            "SELECT 1 FROM messages WHERE id=$1 AND channel_id=$2",
            [data.replyId, cid],
          )
        ).length
      )
        fail("invalid_reply", "Reply must belong to this conversation.");
      if (data.attachments.length) await requireChannel(tx, uid, cid, "attach");
      for (const aid of data.attachments)
        if (
          !(
            await tx.query(
              "SELECT 1 FROM attachments WHERE id=$1 AND owner_id=$2 AND channel_id=$3 AND message_id IS NULL",
              [aid, uid, cid],
            )
          ).length
        )
          fail("invalid_attachment", "Attachment is unavailable.");
      const mid = id();
      await tx.query(
        "INSERT INTO messages(id,channel_id,author_id,content,nonce,reply_id) VALUES($1,$2,$3,$4,$5,$6)",
        [mid, cid, uid, data.content, data.nonce, data.replyId || null],
      );
      for (const aid of data.attachments)
        await tx.query("UPDATE attachments SET message_id=$1 WHERE id=$2", [
          mid,
          aid,
        ]);
      return { id: mid, created: true };
    });
    const message = await messageView(db, result.id);
    if (result.created) {
      await hub.channel(cid, "message.created", message);
      const c = (
        await db.query("SELECT kind FROM channels WHERE id=$1", [cid])
      )[0];
      if (["dm", "group"].includes(c.kind))
        hub.send(
          (await channelAudience(db, cid)).filter((u) => u !== uid),
          "notification",
          {
            kind: "message",
            channelId: cid,
            text: message.display_name + " sent a message",
          },
        );
    }
    return message;
  });
  app.patch("/v1/messages/:id", async (req) => {
    const mid = z.uuid().parse(params(req).id),
      uid = req.identity.uid;
    const [m] = await db.query("SELECT * FROM messages WHERE id=$1", [mid]);
    if (!m) fail("not_found", "Message not found.", 404);
    await requireChannel(db, uid, m.channel_id);
    const data = body(
      req,
      z.object({
        content: z.string().trim().min(1).max(8000).optional(),
        pinned: z.boolean().optional(),
      }),
    );
    if (data.content !== undefined && m.author_id !== uid)
      fail("forbidden", "You can only edit your own messages.", 403);
    if (data.pinned !== undefined) {
      const c = await requireChannel(db, uid, m.channel_id);
      if (c.server_id)
        await requireServer(db, uid, c.server_id, "manage_messages");
    }
    await db.transaction(async (tx) => {
      if (data.content !== undefined) {
        await tx.query(
          "INSERT INTO message_edits(id,message_id,previous_content) VALUES($1,$2,$3)",
          [id(), mid, m.content],
        );
        await tx.query(
          "UPDATE messages SET content=$1,edited_at=now() WHERE id=$2",
          [data.content, mid],
        );
      }
      if (data.pinned !== undefined)
        await tx.query("UPDATE messages SET pinned=$1 WHERE id=$2", [
          data.pinned,
          mid,
        ]);
    });
    const message = await messageView(db, mid);
    await hub.channel(m.channel_id, "message.updated", message);
    return message;
  });
  app.delete("/v1/messages/:id", async (req) => {
    const mid = z.uuid().parse(params(req).id),
      uid = req.identity.uid;
    const [m] = await db.query("SELECT * FROM messages WHERE id=$1", [mid]);
    if (!m) fail("not_found", "Message not found.", 404);
    const c = await requireChannel(db, uid, m.channel_id);
    if (m.author_id !== uid) {
      if (!c.server_id)
        fail("forbidden", "You cannot delete this message.", 403);
      await requireServer(db, uid, c.server_id, "manage_messages");
    }
    await db.query("DELETE FROM messages WHERE id=$1", [mid]);
    await hub.channel(m.channel_id, "message.deleted", {
      id: mid,
      channel_id: m.channel_id,
    });
    return { ok: true };
  });
  app.put("/v1/messages/:id/reactions", async (req) => {
    const mid = z.uuid().parse(params(req).id),
      { emoji, active } = body(
        req,
        z.object({ emoji: z.string().min(1).max(32), active: z.boolean() }),
      );
    const [m] = await db.query("SELECT channel_id FROM messages WHERE id=$1", [
      mid,
    ]);
    if (!m) fail("not_found", "Message not found.", 404);
    await requireChannel(db, req.identity.uid, m.channel_id, "react");
    if (active)
      await db.query(
        "INSERT INTO reactions(message_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [mid, req.identity.uid, emoji],
      );
    else
      await db.query(
        "DELETE FROM reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3",
        [mid, req.identity.uid, emoji],
      );
    const message = await messageView(db, mid);
    await hub.channel(m.channel_id, "message.updated", message);
    return message;
  });
  app.post("/v1/channels/:id/read", async (req) => {
    const cid = z.uuid().parse(params(req).id);
    await requireChannel(db, req.identity.uid, cid);
    const data = body(req, z.object({ at: z.iso.datetime().optional() }));
    const at = data.at ? new Date(data.at) : new Date();
    if (at > new Date()) fail("invalid", "Read time cannot be in the future.");
    await db.query(
      "INSERT INTO read_states(channel_id,user_id,read_at) VALUES($1,$2,$3) ON CONFLICT(channel_id,user_id) DO UPDATE SET read_at=excluded.read_at",
      [cid, req.identity.uid, at],
    );
    hub.send([req.identity.uid], "read.changed", { channelId: cid });
    return { ok: true };
  });
  app.get("/v1/search", async (req) => {
    const q = z
      .object({
        q: z.string().min(1).max(200),
        channelId: z.uuid(),
        from: z.uuid().optional(),
        before: z.iso.datetime().optional(),
        after: z.iso.datetime().optional(),
        attachment: z.enum(["true", "false"]).optional(),
        pinned: z.enum(["true", "false"]).optional(),
      })
      .parse(req.query);
    await requireChannel(db, req.identity.uid, q.channelId);
    const rows = await db.query(
      `SELECT m.id FROM messages m WHERE m.channel_id=$1 AND to_tsvector('simple',m.content) @@ plainto_tsquery('simple',$2) AND ($3::uuid IS NULL OR m.author_id=$3) AND ($4::timestamptz IS NULL OR m.created_at<$4) AND ($5::timestamptz IS NULL OR m.created_at>$5) ${q.attachment === "true" ? "AND EXISTS(SELECT 1 FROM attachments a WHERE a.message_id=m.id)" : ""} ${q.pinned === "true" ? "AND m.pinned" : ""} ORDER BY m.created_at DESC LIMIT 50`,
      [q.channelId, q.q, q.from || null, q.before || null, q.after || null],
    );
    const results = [];
    for (const row of rows) results.push(await messageView(db, row.id));
    return results;
  });
}
