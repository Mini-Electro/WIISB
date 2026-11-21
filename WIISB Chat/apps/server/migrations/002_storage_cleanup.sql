CREATE TABLE storage_objects (key text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO storage_objects(key) SELECT storage_key FROM attachments ON CONFLICT DO NOTHING;
INSERT INTO storage_objects(key) SELECT thumbnail_key FROM attachments WHERE thumbnail_key IS NOT NULL ON CONFLICT DO NOTHING;
