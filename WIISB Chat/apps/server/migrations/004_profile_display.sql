-- How a profile picture and banner are framed: zoom (1 = fit to the frame) and the focal point (0-100 %), plus banner height in px.
ALTER TABLE users
 ADD COLUMN avatar_zoom real NOT NULL DEFAULT 1 CHECK(avatar_zoom BETWEEN 1 AND 4),
 ADD COLUMN avatar_x real NOT NULL DEFAULT 50 CHECK(avatar_x BETWEEN 0 AND 100),
 ADD COLUMN avatar_y real NOT NULL DEFAULT 50 CHECK(avatar_y BETWEEN 0 AND 100),
 ADD COLUMN banner_zoom real NOT NULL DEFAULT 1 CHECK(banner_zoom BETWEEN 1 AND 4),
 ADD COLUMN banner_x real NOT NULL DEFAULT 50 CHECK(banner_x BETWEEN 0 AND 100),
 ADD COLUMN banner_y real NOT NULL DEFAULT 50 CHECK(banner_y BETWEEN 0 AND 100),
 ADD COLUMN banner_height integer NOT NULL DEFAULT 100 CHECK(banner_height BETWEEN 60 AND 220);
