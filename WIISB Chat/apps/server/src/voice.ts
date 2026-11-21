import type { FastifyInstance } from "fastify";
import {
  AccessToken,
  RoomServiceClient,
  TrackSource,
} from "livekit-server-sdk";
import { z } from "zod";
import { config } from "./config.js";
import { params, fail, type Services } from "./core.js";
import { requireChannel } from "./permissions.js";
export async function voiceRoutes(app: FastifyInstance, { db, hub }: Services) {
  app.post("/v1/voice/:id/token", async (req) => {
    const cid = z.uuid().parse(params(req).id),
      uid = req.identity.uid,
      c = await requireChannel(db, uid, cid, "connect");
    if (c.server_id && c.kind !== "voice")
      fail("invalid", "Choose a voice channel.");
    if (!config.livekitUrl || !config.livekitKey || !config.livekitSecret)
      fail(
        "media_unconfigured",
        "Voice is unavailable: the host has not configured a LiveKit media server.",
        503,
      );
    const [user] = await db.query(
      "SELECT display_name FROM users WHERE id=$1",
      [uid],
    );
    const sources: TrackSource[] = [];
    for (const [permission, source] of [
      ["speak", TrackSource.MICROPHONE],
      ["video", TrackSource.CAMERA],
      ["stream", TrackSource.SCREEN_SHARE],
      ["stream", TrackSource.SCREEN_SHARE_AUDIO],
    ] as const) {
      try {
        await requireChannel(db, uid, cid, permission);
        sources.push(source);
      } catch {}
    }
    const token = new AccessToken(config.livekitKey, config.livekitSecret, {
      identity: uid,
      name: user.display_name,
      ttl: "60s",
    });
    token.addGrant({
      room: "channel-" + cid,
      roomJoin: true,
      canSubscribe: true,
      canPublish: sources.length > 0,
      canPublishSources: sources,
      canPublishData: false,
    });
    await hub.channel(cid, "call.started", { channelId: cid, userId: uid });
    return {
      url: config.livekitUrl,
      token: await token.toJwt(),
      permissions: sources,
    };
  });
  // Existing SFU connections are rechecked every 15 seconds, including bans, timeouts and role changes.
  let checking = false;
  const timer = setInterval(
    () =>
      void (async () => {
        if (checking || !config.livekitUrl || !config.livekitKey) return;
        checking = true;
        try {
          const service = new RoomServiceClient(
            config.livekitInternal.replace(/^ws/, "http"),
            config.livekitKey,
            config.livekitSecret,
          );
          const rooms = await service.listRooms();
          for (const room of rooms)
            if (room.name.startsWith("channel-")) {
              const cid = room.name.slice(8),
                participants = await service.listParticipants(room.name);
              for (const p of participants) {
                try {
                  await requireChannel(db, p.identity, cid, "connect");
                  const sources: TrackSource[] = [];
                  for (const [perm, source] of [
                    ["speak", TrackSource.MICROPHONE],
                    ["video", TrackSource.CAMERA],
                    ["stream", TrackSource.SCREEN_SHARE],
                    ["stream", TrackSource.SCREEN_SHARE_AUDIO],
                  ] as const) {
                    try {
                      await requireChannel(db, p.identity, cid, perm);
                      sources.push(source);
                    } catch {}
                  }
                  await service.updateParticipant(
                    room.name,
                    p.identity,
                    undefined,
                    {
                      canSubscribe: true,
                      canPublish: sources.length > 0,
                      canPublishSources: sources,
                      canPublishData: false,
                    },
                  );
                } catch {
                  await service.removeParticipant(room.name, p.identity);
                }
              }
            }
        } catch (e) {
          app.log.warn({ err: e }, "Media permission reconciliation failed");
        } finally {
          checking = false;
        }
      })(),
    15000,
  );
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
}
