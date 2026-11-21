-- Version 2: games found by detection (Steam, Epic, Roblox, Start Menu, extra library folders),
-- plus online cover / hero / icon artwork bookkeeping. Purely additive — existing rows are untouched.

ALTER TABLE games ADD COLUMN source         TEXT    NOT NULL DEFAULT 'catalog';
ALTER TABLE games ADD COLUMN external_id    TEXT;
ALTER TABLE games ADD COLUMN steam_app_id   INTEGER;
ALTER TABLE games ADD COLUMN hidden         INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1));
ALTER TABLE games ADD COLUMN hero_path      TEXT;
ALTER TABLE games ADD COLUMN icon_path      TEXT;
-- 1 once an online cover lookup has been tried (so unknown games are not re-queried on every start).
ALTER TABLE games ADD COLUMN art_attempted  INTEGER NOT NULL DEFAULT 0 CHECK (art_attempted IN (0, 1));

CREATE INDEX idx_games_source ON games(source);
