import { randomUUID, randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyRequest } from "fastify";
import type { Database } from "./db.js";
import type { Hub } from "./realtime.js";
import type { Storage } from "./storage.js";
import type { Mailer } from "./mail.js";
export const id = randomUUID;
export const secret = () => randomBytes(32).toString("base64url");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function fail(code: string, message: string, status = 400): never {
  throw new ApiError(status, code, message);
}
export const uuid = z.uuid();
export const name = z.string().trim().min(1).max(80);
export const permissions = [
  "view",
  "send",
  "attach",
  "react",
  "connect",
  "speak",
  "video",
  "stream",
  "manage_channels",
  "manage_server",
  "manage_roles",
  "manage_messages",
  "invite",
  "kick",
  "ban",
  "audit",
] as const;
export type Permission = (typeof permissions)[number];
export const defaultPermissions: Permission[] = [
  "view",
  "send",
  "attach",
  "react",
  "connect",
  "speak",
  "video",
  "stream",
  "invite",
];
export type Identity = { uid: string; sid: string };
declare module "fastify" {
  interface FastifyRequest {
    identity: Identity;
  }
}
export type Services = {
  db: Database;
  hub: Hub;
  storage: Storage;
  mailer: Mailer;
};
export const body = <T>(req: FastifyRequest, schema: z.ZodType<T>): T =>
  schema.parse(req.body);
export const params = (req: FastifyRequest) =>
  req.params as Record<string, string>;
export const publicUser = `id,username,display_name,bio,pronouns,status,accent,avatar_id,banner_id,avatar_zoom,avatar_x,avatar_y,banner_zoom,banner_x,banner_y,banner_height,created_at`;
export async function blocked(
  db: import("./db.js").Query,
  a: string,
  b: string,
) {
  return (
    (
      await db.query(
        "SELECT 1 FROM blocks WHERE (user_id=$1 AND blocked_id=$2) OR (user_id=$2 AND blocked_id=$1)",
        [a, b],
      )
    ).length > 0
  );
}
