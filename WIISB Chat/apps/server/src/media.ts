import type { FastifyInstance } from "fastify";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { basename, extname } from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import { params, id, fail, type Services } from "./core.js";
import { requireChannel } from "./permissions.js";
const allowed = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/flac",
  "audio/mp4",
  "application/pdf",
  "application/zip",
  "application/x-7z-compressed",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
export async function mediaRoutes(
  app: FastifyInstance,
  { db, storage }: Services,
) {
  app.post(
    "/v1/channels/:id/attachments",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      const cid = z.uuid().parse(params(req).id);
      await requireChannel(db, req.identity.uid, cid, "attach");
      return upload(req, cid, "message");
    },
  );
  app.post("/v1/profile-assets/:kind", async (req) => {
    const kind = z.enum(["avatar", "banner"]).parse(params(req).kind);
    const asset = await upload(req, null, kind);
    await db.query(`UPDATE users SET ${kind}_id=$1 WHERE id=$2`, [
      asset.id,
      req.identity.uid,
    ]);
    return asset;
  });
  async function upload(
    req: import("fastify").FastifyRequest,
    cid: string | null,
    kind: string,
  ) {
    const file = await req.file({
      limits: {
        fileSize: kind === "message" ? config.maxUpload : 10 * 1024 * 1024,
        files: 1,
        fields: 0,
      },
    });
    if (!file) fail("no_file", "Choose a file to upload.");
    const buffer = await file.toBuffer();
    if (file.file.truncated)
      fail("too_large", "This file exceeds the configured upload size.", 413);
    if (
      /\.(exe|msi|bat|cmd|ps1|com|scr|dll|js|vbs|html|htm|svg|lnk)$/i.test(
        file.filename,
      )
    )
      fail(
        "unsupported_type",
        "Executable and active content file extensions are not permitted.",
        415,
      );
    let detected = await fileTypeFromBuffer(buffer),
      mime = detected?.mime;
    if (
      !mime &&
      [".txt", ".md", ".csv", ".json", ".log"].includes(
        extname(file.filename).toLowerCase(),
      ) &&
      !buffer.includes(0)
    )
      mime = "text/plain";
    if (!mime || (!allowed.has(mime) && mime !== "text/plain"))
      fail("unsupported_type", "This file type is not permitted.", 415);
    if (kind !== "message" && !mime.startsWith("image/"))
      fail("image_required", "Choose a PNG, JPEG, GIF, WebP or AVIF image.");
    const aid = id(),
      key = id();
    let thumb: Buffer | undefined;
    if (mime.startsWith("image/")) {
      try {
        const image = sharp(buffer, { limitInputPixels: 40000000 });
        const meta = await image.metadata();
        if (!meta.width || !meta.height) throw new Error();
        thumb = await image
          .resize(640, 480, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();
      } catch {
        fail(
          "invalid_image",
          "The image is malformed or exceeds the pixel limit.",
        );
      }
    }
    const safeName =
      basename(file.filename.replaceAll("\\", "/"))
        .replace(/[\x00-\x1f\x7f]/g, "")
        .slice(0, 180) || "attachment";
    await storage.put(key, buffer, mime);
    if (thumb) await storage.put(key + ".thumb", thumb, "image/webp");
    try {
      await db.transaction(async (tx) => {
        await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
          req.identity.uid,
        ]);
        const [quota] = await tx.query(
          "SELECT coalesce(sum(size),0)::bigint AS used FROM attachments WHERE owner_id=$1",
          [req.identity.uid],
        );
        if (Number(quota.used) + buffer.length > config.userStorage)
          fail(
            "storage_quota",
            "Your account has reached the host’s configured storage allowance.",
            413,
          );
        await tx.query(
          "INSERT INTO attachments(id,channel_id,owner_id,name,mime,size,storage_key,thumbnail_key,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            aid,
            cid,
            req.identity.uid,
            safeName,
            mime,
            buffer.length,
            key,
            thumb ? key + ".thumb" : null,
            kind,
          ],
        );
        await tx.query("INSERT INTO storage_objects(key) VALUES($1)", [key]);
        if (thumb)
          await tx.query("INSERT INTO storage_objects(key) VALUES($1)", [
            key + ".thumb",
          ]);
      });
    } catch (e) {
      await storage.remove(key);
      if (thumb) await storage.remove(key + ".thumb");
      throw e;
    }
    return {
      id: aid,
      name: safeName,
      mime,
      size: buffer.length,
      thumbnail: !!thumb,
    };
  }
  app.get("/v1/attachments/:id", async (req, reply) => {
    const aid = z.uuid().parse(params(req).id),
      query = z
        .object({ thumbnail: z.enum(["true", "false"]).optional() })
        .parse(req.query);
    const [a] = await db.query("SELECT * FROM attachments WHERE id=$1", [aid]);
    if (!a) fail("not_found", "Attachment is unavailable.", 404);
    if (a.channel_id) {
      await requireChannel(db, req.identity.uid, a.channel_id);
      if (!a.message_id && a.owner_id !== req.identity.uid)
        fail("forbidden", "This upload has not been shared.", 403);
    } else if (
      !(
        await db.query(
          "SELECT 1 FROM users WHERE avatar_id=$1 OR banner_id=$1",
          [aid],
        )
      ).length
    )
      fail("not_found", "Profile asset is no longer in use.", 404);
    const thumb = query.thumbnail === "true" && a.thumbnail_key;
    reply
      .header("Cache-Control", "private, max-age=60")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header(
        "Content-Disposition",
        `${a.mime.startsWith("image/") || a.mime.startsWith("video/") || a.mime.startsWith("audio/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name).replaceAll("'", "%27")}`,
      )
      .type(thumb ? "image/webp" : a.mime);
    return reply.send(await storage.get(thumb || a.storage_key));
  });
}
