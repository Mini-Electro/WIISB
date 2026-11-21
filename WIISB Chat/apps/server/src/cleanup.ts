import type { Services } from "./core.js";
export async function collectStorage({ db, storage }: Services) {
  // Unsent uploads expire after 24 hours; old profile images expire when replaced.
  await db.query(
    "DELETE FROM attachments a WHERE a.created_at<now()-interval '24 hours' AND ((a.kind='message' AND a.message_id IS NULL) OR (a.kind<>'message' AND NOT EXISTS(SELECT 1 FROM users u WHERE u.avatar_id=a.id OR u.banner_id=a.id)))",
  );
  const objects = await db.query(
    "SELECT key FROM storage_objects o WHERE o.created_at<now()-interval '1 hour' AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.storage_key=o.key OR a.thumbnail_key=o.key) LIMIT 1000",
  );
  for (const object of objects) {
    await storage.remove(object.key);
    await db.query("DELETE FROM storage_objects WHERE key=$1", [object.key]);
  }
  return objects.length;
}
