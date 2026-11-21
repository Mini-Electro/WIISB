import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  body,
  params,
  id,
  secret,
  name,
  permissions,
  defaultPermissions,
  fail,
  type Services,
} from "./core.js";
import {
  requireServer,
  requireChannel,
  serverPermissions,
} from "./permissions.js";
export async function communityRoutes(
  app: FastifyInstance,
  { db, hub }: Services,
) {
  const audit = async (
    sid: string,
    uid: string,
    action: string,
    target?: string,
    reason = "",
  ) =>
    db.query(
      "INSERT INTO audit_logs(id,server_id,actor_id,target_id,action,reason) VALUES($1,$2,$3,$4,$5,$6)",
      [id(), sid, uid, target || null, action, reason],
    );
  app.get("/v1/servers", async (req) =>
    db.query(
      "SELECT s.* FROM communities s JOIN members m ON m.server_id=s.id WHERE m.user_id=$1 ORDER BY s.created_at",
      [req.identity.uid],
    ),
  );
  app.post("/v1/servers", async (req) => {
    const data = body(
        req,
        z.object({ name, description: z.string().max(1000).default("") }),
      ),
      sid = id(),
      uid = req.identity.uid;
    const server = await db.transaction(async (tx) => {
      const [row] = await tx.query(
        "INSERT INTO communities(id,name,description,owner_id) VALUES($1,$2,$3,$4) RETURNING *",
        [sid, data.name, data.description, uid],
      );
      await tx.query("INSERT INTO members(server_id,user_id) VALUES($1,$2)", [
        sid,
        uid,
      ]);
      await tx.query(
        "INSERT INTO roles(id,server_id,name,permissions,is_default,position) VALUES($1,$2,'Everyone',$3,true,0)",
        [id(), sid, JSON.stringify(defaultPermissions)],
      );
      for (const [label, kind] of [
        ["general", "text"],
        ["Lounge", "voice"],
      ])
        await tx.query(
          "INSERT INTO channels(id,server_id,name,kind) VALUES($1,$2,$3,$4)",
          [id(), sid, label, kind],
        );
      return row;
    });
    hub.send([uid], "state.changed", {});
    return server;
  });
  app.get("/v1/servers/:id", async (req) => {
    const sid = z.uuid().parse(params(req).id),
      uid = req.identity.uid,
      access = await serverPermissions(db, uid, sid);
    const channels = [];
    for (const c of await db.query(
      "SELECT * FROM channels WHERE server_id=$1 ORDER BY category,position,name",
      [sid],
    )) {
      try {
        await requireChannel(db, uid, c.id);
        const [count] = await db.query(
          `SELECT count(*)::int AS unread FROM messages WHERE channel_id=$1 AND author_id<>$2 AND created_at>coalesce((SELECT read_at FROM read_states WHERE channel_id=$1 AND user_id=$2),'1970-01-01'::timestamptz)`,
          [c.id, uid],
        );
        channels.push({ ...c, unread: count.unread });
      } catch {}
    }
    const members = await db.query(
      "SELECT u.id,u.username,u.display_name,u.avatar_id,u.avatar_zoom,u.avatar_x,u.avatar_y,u.presence,u.status,m.timeout_until FROM users u JOIN members m ON m.user_id=u.id WHERE m.server_id=$1 ORDER BY u.display_name",
      [sid],
    );
    for (const m of members) {
      m.presence = hub.status(m.id, m.presence);
      m.roles = (
        await db.query(
          "SELECT role_id FROM member_roles WHERE server_id=$1 AND user_id=$2",
          [sid, m.id],
        )
      ).map((r) => r.role_id);
    }
    return {
      ...access.server,
      channels,
      members,
      roles: await db.query(
        "SELECT * FROM roles WHERE server_id=$1 ORDER BY position DESC",
        [sid],
      ),
      myPermissions: access.owner ? [...permissions] : [...access.permissions],
      owner: access.owner,
    };
  });
  app.patch("/v1/servers/:id", async (req) => {
    const sid = z.uuid().parse(params(req).id),
      uid = req.identity.uid;
    await requireServer(db, uid, sid, "manage_server");
    const data = body(
      req,
      z.object({
        name: name.optional(),
        description: z.string().max(1000).optional(),
        accent: z
          .string()
          .regex(/^#[\da-fA-F]{6}$/)
          .optional(),
      }),
    );
    for (const [col, value] of Object.entries(data))
      await db.query(`UPDATE communities SET ${col}=$1 WHERE id=$2`, [
        value,
        sid,
      ]);
    await audit(sid, uid, "server.updated");
    await hub.community(sid);
    return { ok: true };
  });
  app.post("/v1/servers/:id/transfer", async (req) => {
    const sid = z.uuid().parse(params(req).id),
      access = await serverPermissions(db, req.identity.uid, sid);
    if (!access.owner)
      fail("forbidden", "Only the owner can transfer ownership.", 403);
    const { userId } = body(req, z.object({ userId: z.uuid() }));
    await serverPermissions(db, userId, sid);
    await db.query("UPDATE communities SET owner_id=$1 WHERE id=$2", [
      userId,
      sid,
    ]);
    await audit(sid, req.identity.uid, "ownership.transferred", userId);
    await hub.community(sid);
    return { ok: true };
  });
  app.delete("/v1/servers/:id", async (req) => {
    const sid = z.uuid().parse(params(req).id),
      access = await serverPermissions(db, req.identity.uid, sid);
    if (!access.owner)
      fail("forbidden", "Only the owner can delete this community.", 403);
    const { confirmation } = body(req, z.object({ confirmation: z.string() }));
    if (confirmation !== access.server.name)
      fail("confirmation", "Enter the community name to confirm deletion.");
    const users = (
      await db.query("SELECT user_id FROM members WHERE server_id=$1", [sid])
    ).map((r) => r.user_id);
    await db.query("DELETE FROM communities WHERE id=$1", [sid]);
    hub.send(users, "state.changed", {});
    return { ok: true };
  });
  app.post("/v1/servers/:id/leave", async (req) => {
    const sid = z.uuid().parse(params(req).id),
      access = await serverPermissions(db, req.identity.uid, sid);
    if (access.owner) fail("owner", "Transfer ownership before leaving.");
    await db.query("DELETE FROM members WHERE server_id=$1 AND user_id=$2", [
      sid,
      req.identity.uid,
    ]);
    await hub.community(sid);
    hub.send([req.identity.uid], "state.changed", {});
    return { ok: true };
  });
  const channelSchema = z.object({
    name,
    kind: z.enum(["text", "voice", "announcement", "media"]).default("text"),
    topic: z.string().max(500).default(""),
    category: z.string().max(50).default("CHANNELS"),
    private: z.boolean().default(false),
    allowed_roles: z.array(z.uuid()).max(50).default([]),
    position: z.number().int().min(0).max(10000).default(0),
    slow_mode: z.number().int().min(0).max(21600).default(0),
  });
  app.post("/v1/servers/:id/channels", async (req) => {
    const sid = z.uuid().parse(params(req).id);
    await requireServer(db, req.identity.uid, sid, "manage_channels");
    const c = body(req, channelSchema);
    for (const rid of c.allowed_roles)
      if (
        !(
          await db.query("SELECT 1 FROM roles WHERE id=$1 AND server_id=$2", [
            rid,
            sid,
          ])
        ).length
      )
        fail("invalid_role", "Role belongs to another community.");
    const [row] = await db.query(
      "INSERT INTO channels(id,server_id,name,kind,topic,category,private,allowed_roles,position,slow_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
      [
        id(),
        sid,
        c.name,
        c.kind,
        c.topic,
        c.category,
        c.private,
        JSON.stringify(c.allowed_roles),
        c.position,
        c.slow_mode,
      ],
    );
    await audit(sid, req.identity.uid, "channel.created", row.id);
    await hub.community(sid);
    return row;
  });
  app.patch("/v1/channels/:id", async (req) => {
    const cid = z.uuid().parse(params(req).id),
      c = await requireChannel(db, req.identity.uid, cid);
    if (!c.server_id) fail("invalid", "Use group conversation settings.");
    await requireServer(db, req.identity.uid, c.server_id, "manage_channels");
    const data = body(req, channelSchema.partial());
    for (const rid of data.allowed_roles || [])
      if (
        !(
          await db.query("SELECT 1 FROM roles WHERE id=$1 AND server_id=$2", [
            rid,
            c.server_id,
          ])
        ).length
      )
        fail("invalid_role", "Role belongs to another community.");
    for (const [col, v] of Object.entries(data))
      await db.query(`UPDATE channels SET ${col}=$1 WHERE id=$2`, [
        col === "allowed_roles" ? JSON.stringify(v) : v,
        cid,
      ]);
    await audit(c.server_id, req.identity.uid, "channel.updated", cid);
    await hub.community(c.server_id);
    return { ok: true };
  });
  app.delete("/v1/channels/:id", async (req) => {
    const cid = z.uuid().parse(params(req).id),
      c = await requireChannel(db, req.identity.uid, cid);
    if (!c.server_id) fail("invalid", "This is not a community channel.");
    await requireServer(db, req.identity.uid, c.server_id, "manage_channels");
    await db.query("DELETE FROM channels WHERE id=$1", [cid]);
    await audit(c.server_id, req.identity.uid, "channel.deleted", cid);
    await hub.community(c.server_id);
    return { ok: true };
  });
  app.post("/v1/servers/:id/invites", async (req) => {
    const sid = z.uuid().parse(params(req).id);
    await requireServer(db, req.identity.uid, sid, "invite");
    const data = body(
      req,
      z.object({
        hours: z.number().int().min(1).max(720).default(24),
        maxUses: z.number().int().min(1).max(10000).default(25),
      }),
    );
    const token = secret();
    await db.query(
      "INSERT INTO invites(token,server_id,creator_id,expires_at,max_uses) VALUES($1,$2,$3,$4,$5)",
      [
        token,
        sid,
        req.identity.uid,
        new Date(Date.now() + data.hours * 3600000),
        data.maxUses,
      ],
    );
    return { token, expiresAt: new Date(Date.now() + data.hours * 3600000) };
  });
  app.get("/v1/invites/:token", async (req) => {
    const [row] = await db.query(
      "SELECT s.id,s.name,s.description,i.expires_at,i.max_uses,i.uses FROM invites i JOIN communities s ON s.id=i.server_id WHERE i.token=$1 AND NOT i.revoked AND i.expires_at>now() AND i.uses<i.max_uses",
      [params(req).token],
    );
    if (!row)
      fail(
        "invite_invalid",
        "Invitation is invalid, expired, or used up.",
        404,
      );
    return row;
  });
  app.post("/v1/invites/:token/join", async (req) => {
    const sid = await db.transaction(async (tx) => {
      const [invite] = await tx.query(
        "SELECT * FROM invites WHERE token=$1 FOR UPDATE",
        [params(req).token],
      );
      if (
        !invite ||
        invite.revoked ||
        new Date(invite.expires_at) <= new Date() ||
        invite.uses >= invite.max_uses
      )
        fail("invite_invalid", "Invitation is invalid, expired, or used up.");
      if (
        (
          await tx.query(
            "SELECT 1 FROM bans WHERE server_id=$1 AND user_id=$2",
            [invite.server_id, req.identity.uid],
          )
        ).length
      )
        fail("banned", "You cannot join this community.", 403);
      const added = await tx.query(
        "INSERT INTO members(server_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING user_id",
        [invite.server_id, req.identity.uid],
      );
      if (added.length)
        await tx.query("UPDATE invites SET uses=uses+1 WHERE token=$1", [
          invite.token,
        ]);
      return invite.server_id;
    });
    await hub.community(sid);
    return { serverId: sid };
  });
  app.delete("/v1/invites/:token", async (req) => {
    const [invite] = await db.query("SELECT * FROM invites WHERE token=$1", [
      params(req).token,
    ]);
    if (!invite) fail("not_found", "Invitation not found.", 404);
    await requireServer(
      db,
      req.identity.uid,
      invite.server_id,
      "manage_server",
    );
    await db.query("UPDATE invites SET revoked=true WHERE token=$1", [
      invite.token,
    ]);
    return { ok: true };
  });
  app.get("/v1/servers/:id/invites", async (req) => {
    await requireServer(db, req.identity.uid, params(req).id, "manage_server");
    return db.query(
      "SELECT * FROM invites WHERE server_id=$1 AND NOT revoked ORDER BY expires_at DESC",
      [params(req).id],
    );
  });
  const roleSchema = z.object({
    name,
    color: z.string().regex(/^#[\da-fA-F]{6}$/),
    position: z.number().int().min(1).max(1000),
    permissions: z.array(z.enum(permissions)).max(permissions.length),
  });
  app.post("/v1/servers/:id/roles", async (req) => {
    const sid = z.uuid().parse(params(req).id),
      access = await requireServer(db, req.identity.uid, sid, "manage_roles"),
      r = body(req, roleSchema);
    if (
      !access.owner &&
      (r.position >= access.position ||
        r.permissions.some((p) => !access.permissions.has(p)))
    )
      fail(
        "hierarchy",
        "You cannot grant permissions or rank above your own.",
        403,
      );
    const [role] = await db.query(
      "INSERT INTO roles(id,server_id,name,color,position,permissions) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [id(), sid, r.name, r.color, r.position, JSON.stringify(r.permissions)],
    );
    await audit(sid, req.identity.uid, "role.created", role.id);
    await hub.community(sid);
    return role;
  });
  app.delete("/v1/servers/:id/roles/:roleId", async (req) => {
    const { id: sid, roleId } = params(req),
      access = await requireServer(db, req.identity.uid, sid, "manage_roles");
    const [role] = await db.query(
      "SELECT * FROM roles WHERE id=$1 AND server_id=$2",
      [roleId, sid],
    );
    if (!role || role.is_default)
      fail("invalid", "The default role cannot be deleted.");
    if (!access.owner && role.position >= access.position)
      fail("hierarchy", "This role is above your rank.", 403);
    await db.query("DELETE FROM roles WHERE id=$1", [roleId]);
    await audit(sid, req.identity.uid, "role.deleted", roleId);
    await hub.community(sid);
    return { ok: true };
  });
  app.patch("/v1/servers/:id/roles/:roleId", async (req) => {
    const { id: sid, roleId } = params(req),
      access = await requireServer(db, req.identity.uid, sid, "manage_roles");
    const [role] = await db.query(
      "SELECT * FROM roles WHERE id=$1 AND server_id=$2",
      [roleId, sid],
    );
    if (!role) fail("not_found", "Role not found.", 404);
    const data = body(
      req,
      roleSchema
        .extend({ position: z.number().int().min(0).max(1000) })
        .partial(),
    );
    const position = data.position ?? role.position,
      perms = data.permissions ?? role.permissions;
    if (role.is_default && position !== 0)
      fail("invalid", "The default role must remain at rank zero.");
    if (
      !access.owner &&
      (role.position >= access.position ||
        position >= access.position ||
        perms.some((p: string) => !access.permissions.has(p)))
    )
      fail(
        "hierarchy",
        "You cannot grant permissions or rank above your own.",
        403,
      );
    for (const [col, value] of Object.entries(data))
      await db.query(`UPDATE roles SET ${col}=$1 WHERE id=$2`, [
        col === "permissions" ? JSON.stringify(value) : value,
        roleId,
      ]);
    await audit(sid, req.identity.uid, "role.updated", roleId);
    await hub.community(sid);
    return { ok: true };
  });
  app.get("/v1/servers/:id/bans", async (req) => {
    const sid = z.uuid().parse(params(req).id);
    await requireServer(db, req.identity.uid, sid, "ban");
    return db.query(
      "SELECT u.id,u.username,u.display_name,b.reason FROM bans b JOIN users u ON u.id=b.user_id WHERE b.server_id=$1",
      [sid],
    );
  });
  app.put("/v1/servers/:id/members/:userId/roles", async (req) => {
    const { id: sid, userId } = params(req),
      access = await requireServer(db, req.identity.uid, sid, "manage_roles"),
      target = await serverPermissions(db, userId, sid);
    const { roles } = body(req, z.object({ roles: z.array(z.uuid()).max(50) }));
    if (
      !access.owner &&
      (target.owner ||
        target.position >= access.position ||
        userId === req.identity.uid)
    )
      fail("hierarchy", "You cannot manage this member.", 403);
    for (const rid of roles) {
      const [r] = await db.query(
        "SELECT * FROM roles WHERE id=$1 AND server_id=$2",
        [rid, sid],
      );
      if (
        !r ||
        r.is_default ||
        (!access.owner &&
          (r.position >= access.position ||
            r.permissions.some((p: string) => !access.permissions.has(p))))
      )
        fail("hierarchy", "You cannot assign this role.", 403);
    }
    await db.transaction(async (tx) => {
      await tx.query(
        "DELETE FROM member_roles WHERE server_id=$1 AND user_id=$2",
        [sid, userId],
      );
      for (const rid of roles)
        await tx.query(
          "INSERT INTO member_roles(server_id,user_id,role_id) VALUES($1,$2,$3)",
          [sid, userId, rid],
        );
    });
    await audit(sid, req.identity.uid, "roles.assigned", userId);
    await hub.community(sid);
    return { ok: true };
  });
  app.post("/v1/servers/:id/moderation", async (req) => {
    const sid = z.uuid().parse(params(req).id),
      uid = req.identity.uid,
      data = body(
        req,
        z.object({
          action: z.enum(["kick", "ban", "unban", "timeout"]),
          userId: z.uuid(),
          reason: z.string().max(1000).default(""),
          minutes: z.number().int().min(0).max(40320).default(60),
        }),
      );
    const access = await requireServer(
      db,
      uid,
      sid,
      data.action === "ban" || data.action === "unban" ? "ban" : "kick",
    );
    if (data.userId === uid || data.userId === access.server.owner_id)
      fail("hierarchy", "You cannot moderate this member.", 403);
    if (data.action !== "unban") {
      const target = await serverPermissions(db, data.userId, sid);
      if (!access.owner && target.position >= access.position)
        fail(
          "hierarchy",
          "You cannot moderate members at or above your rank.",
          403,
        );
    }
    await db.transaction(async (tx) => {
      if (data.action === "ban")
        await tx.query(
          "INSERT INTO bans(server_id,user_id,reason) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [sid, data.userId, data.reason],
        );
      if (data.action === "unban")
        await tx.query("DELETE FROM bans WHERE server_id=$1 AND user_id=$2", [
          sid,
          data.userId,
        ]);
      if (["kick", "ban"].includes(data.action))
        await tx.query(
          "DELETE FROM members WHERE server_id=$1 AND user_id=$2",
          [sid, data.userId],
        );
      if (data.action === "timeout")
        await tx.query(
          "UPDATE members SET timeout_until=$1 WHERE server_id=$2 AND user_id=$3",
          [new Date(Date.now() + data.minutes * 60000), sid, data.userId],
        );
    });
    await audit(sid, uid, data.action, data.userId, data.reason);
    await hub.community(sid);
    hub.send([data.userId], "state.changed", {});
    return { ok: true };
  });
  app.get("/v1/servers/:id/audit", async (req) => {
    await requireServer(db, req.identity.uid, params(req).id, "audit");
    return db.query(
      "SELECT * FROM audit_logs WHERE server_id=$1 ORDER BY created_at DESC LIMIT 100",
      [params(req).id],
    );
  });
  app.post("/v1/reports", async (req) => {
    const data = body(
      req,
      z.object({ targetId: z.uuid(), reason: z.string().min(3).max(2000) }),
    );
    await db.query(
      "INSERT INTO reports(id,reporter_id,target_id,reason) VALUES($1,$2,$3,$4)",
      [id(), req.identity.uid, data.targetId, data.reason],
    );
    return { ok: true };
  });
}
