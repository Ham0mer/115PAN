ALTER TABLE media_library ADD COLUMN show_cid TEXT;

CREATE INDEX IF NOT EXISTS idx_media_library_show ON media_library(media_type, tmdb_id, show_cid);
