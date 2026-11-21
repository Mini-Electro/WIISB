import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { config } from "./config.js";
export interface Storage {
  put(key: string, data: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}
export function createStorage(directory: string): Storage {
  if (config.storage === "s3") {
    if (!config.s3Bucket) throw new Error("S3_BUCKET is required.");
    const client = new S3Client({
      region: config.s3Region,
      endpoint: config.s3Endpoint,
      forcePathStyle: true,
    });
    return {
      async put(key, data, mime) {
        await client.send(
          new PutObjectCommand({
            Bucket: config.s3Bucket,
            Key: key,
            Body: data,
            ContentType: mime,
          }),
        );
      },
      async get(key) {
        const r = await client.send(
          new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }),
        );
        return Buffer.from(await r.Body!.transformToByteArray());
      },
      async remove(key) {
        await client.send(
          new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: key }),
        );
      },
    };
  }
  const root = resolve(directory);
  const file = (key: string) => {
    if (!/^[a-f0-9-]+(?:\.thumb)?$/.test(key))
      throw new Error("Invalid storage key");
    return join(root, key);
  };
  return {
    async put(key, data) {
      await mkdir(root, { recursive: true });
      await writeFile(file(key), data, { flag: "wx" });
    },
    async get(key) {
      return readFile(file(key));
    },
    async remove(key) {
      await unlink(file(key)).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    },
  };
}
