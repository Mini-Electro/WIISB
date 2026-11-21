import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { Database } from "./db.js";
import { z } from "zod";
import { id, secret, fail, type Identity } from "./core.js";
import { requireChannel, channelAudience } from "./permissions.js";
type Client = {
  socket: WebSocket;
  identity: Identity;
  seen: number;
  count: number;
  window: number;
};
export class Hub {
  clients = new Set<Client>();
  tickets = new Map<string, { identity: Identity; expires: number }>();
  stopping = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(public db: Database) {
    this.timer = setInterval(() => void this.sweep().catch(() => {}), 15000);
    this.timer.unref();
  }
  async sweep() {
    if (this.stopping) return;
    for (const [key, ticket] of this.tickets)
      if (ticket.expires < Date.now()) this.tickets.delete(key);
    for (const client of this.clients) {
      if (this.stopping) return;
      const rows = await this.db.query(
        "SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND NOT u.suspended",
        [client.identity.sid],
      );
      if (Date.now() - client.seen > 45000 || !rows.length)
        client.socket.close(4001, "Session expired");
    }
  }
  send(users: string[], type: string, payload: any, resourceId?: string) {
    const event = JSON.stringify({
      v: 1,
      id: id(),
      type,
      resourceId,
      at: new Date().toISOString(),
      payload,
    });
    for (const c of this.clients)
      if (users.includes(c.identity.uid) && c.socket.readyState === 1) {
        if (c.socket.bufferedAmount > 1024 * 1024)
          c.socket.close(4008, "Client too slow");
        else c.socket.send(event);
      }
  }
  async channel(cid: string, type: string, payload: any) {
    this.send(await channelAudience(this.db, cid), type, payload, cid);
  }
  async community(sid: string) {
    this.send(
      (
        await this.db.query("SELECT user_id FROM members WHERE server_id=$1", [
          sid,
        ])
      ).map((r) => r.user_id),
      "state.changed",
      {},
      sid,
    );
  }
  async presence(uid: string) {
    if (this.stopping) return;
    const peers = await this.db.query(
      `SELECT friend_id AS user_id FROM friendships WHERE user_id=$1 UNION SELECT m2.user_id FROM members m JOIN members m2 ON m.server_id=m2.server_id WHERE m.user_id=$1`,
      [uid],
    );
    if (this.stopping) return;
    const [user] = await this.db.query(
      "SELECT presence,status FROM users WHERE id=$1",
      [uid],
    );
    this.send(
      peers.map((p) => p.user_id),
      "presence.changed",
      {
        userId: uid,
        presence: this.status(uid, user?.presence),
        status: user?.status,
      },
    );
  }
  status(uid: string, presence = "online") {
    return presence === "invisible" ||
      ![...this.clients].some((c) => c.identity.uid === uid)
      ? "offline"
      : presence;
  }
  closeSession(sid: string) {
    for (const c of this.clients)
      if (c.identity.sid === sid) c.socket.close(4001, "Session revoked");
  }
  closeUser(uid: string, except?: string) {
    for (const c of this.clients)
      if (c.identity.uid === uid && c.identity.sid !== except)
        c.socket.close(4001, "Session revoked");
  }
  close() {
    this.stopping = true;
    clearInterval(this.timer);
    for (const c of this.clients) c.socket.terminate();
  }
}
export async function realtimeRoutes(app: FastifyInstance, hub: Hub) {
  app.post("/v1/realtime-ticket", async (req) => {
    const ticket = secret();
    hub.tickets.set(ticket, {
      identity: req.identity,
      expires: Date.now() + 30000,
    });
    return { ticket };
  });
  app.get("/v1/events", { websocket: true }, (socket, req) => {
    const ticket = (req.query as any).ticket;
    const auth = hub.tickets.get(ticket);
    hub.tickets.delete(ticket);
    if (!auth || auth.expires < Date.now()) {
      socket.close(4001, "Invalid ticket");
      return;
    }
    const client: Client = {
      socket,
      identity: auth.identity,
      seen: Date.now(),
      count: 0,
      window: Date.now(),
    };
    hub.clients.add(client);
    hub.send([auth.identity.uid], "ready", { resync: true });
    void hub.presence(auth.identity.uid).catch(() => {});
    socket.on(
      "message",
      (raw) =>
        void (async () => {
          if (Date.now() - client.window > 10000) {
            client.count = 0;
            client.window = Date.now();
          }
          if (++client.count > 60) {
            socket.close(4008, "Rate limited");
            return;
          }
          try {
            const event = z
              .discriminatedUnion("type", [
                z.object({ type: z.literal("ping") }),
                z.object({
                  type: z.literal("typing"),
                  channelId: z.uuid(),
                  active: z.boolean(),
                }),
              ])
              .parse(JSON.parse(raw.toString()));
            client.seen = Date.now();
            if (event.type === "ping") {
              socket.send(
                JSON.stringify({
                  v: 1,
                  type: "pong",
                  at: new Date().toISOString(),
                }),
              );
              return;
            }
            await requireChannel(
              hub.db,
              auth.identity.uid,
              event.channelId,
              "send",
            );
            await hub.channel(event.channelId, "typing", {
              userId: auth.identity.uid,
              active: event.active,
            });
          } catch {
            socket.send(
              JSON.stringify({
                v: 1,
                type: "error",
                payload: { code: "invalid_event" },
              }),
            );
          }
        })().catch(() => socket.close(1011, "Event failed")),
    );
    socket.on("close", () => {
      hub.clients.delete(client);
      void hub.presence(auth.identity.uid).catch(() => {});
    });
  });
}
