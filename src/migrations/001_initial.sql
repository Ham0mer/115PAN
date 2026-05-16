CREATE TABLE IF NOT EXISTS cookies_115 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_name TEXT DEFAULT 'apple_tv',
  cookie_str TEXT NOT NULL,
  user_id TEXT,
  user_name TEXT,
  face_m TEXT,
  size_used TEXT,
  size_total TEXT,
  size_used_raw INTEGER,
  size_total_raw INTEGER,
  vip_info TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  expires_at TEXT,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','expired','replaced'))
);

CREATE TABLE IF NOT EXISTS config_organize (
  id INTEGER PRIMARY KEY CHECK(id=1),
  source_cid TEXT,
  source_name TEXT,
  target_cid TEXT,
  target_name TEXT,
  scan_interval_min INTEGER DEFAULT 10,
  video_extensions TEXT DEFAULT 'mp4,mkv,avi,mov,rmvb,wmv,ts,iso,m2ts',
  meta_extensions TEXT DEFAULT 'ass,srt,ssa,sub,vtt,nfo,xml',
  rename_enabled INTEGER DEFAULT 1,
  ffprobe_enabled INTEGER DEFAULT 0,
  ai_enabled INTEGER DEFAULT 0,
  min_video_size_mb REAL DEFAULT 100,
  operation_delay_sec REAL DEFAULT 10,
  secondary_category INTEGER DEFAULT 1,
  tertiary_category INTEGER DEFAULT 0,
  episode_per_notify INTEGER DEFAULT 0,
  remux_priority INTEGER DEFAULT 1,
  resolution_priority INTEGER DEFAULT 1,
  dolby_priority INTEGER DEFAULT 1,
  multi_version INTEGER DEFAULT 0,
  conflict_mode INTEGER DEFAULT 2 CHECK(conflict_mode IN (0,1,2)),
  notify_enabled INTEGER DEFAULT 1,
  notify_bot_id INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

INSERT OR IGNORE INTO config_organize (id) VALUES (1);

CREATE TABLE IF NOT EXISTS config_telegram (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT DEFAULT 'Default',
  bot_token TEXT,
  chat_ids TEXT,
  enabled INTEGER DEFAULT 0,
  notify_success INTEGER DEFAULT 1,
  notify_failure INTEGER DEFAULT 1,
  notify_cookie INTEGER DEFAULT 1,
  notify_system INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS config_tmdb (
  id INTEGER PRIMARY KEY CHECK(id=1),
  api_key TEXT,
  base_url TEXT DEFAULT 'https://api.themoviedb.org/3',
  image_domain TEXT DEFAULT 'https://image.tmdb.org/t/p',
  primary_lang TEXT DEFAULT 'zh-CN',
  fallback_lang TEXT DEFAULT 'en-US',
  timeout_sec INTEGER DEFAULT 10,
  max_retries INTEGER DEFAULT 3,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

INSERT OR IGNORE INTO config_tmdb (id) VALUES (1);

CREATE TABLE IF NOT EXISTS config_ai (
  id INTEGER PRIMARY KEY CHECK(id=1),
  base_url TEXT,
  api_key TEXT,
  model TEXT DEFAULT 'gpt-3.5-turbo',
  temperature REAL DEFAULT 0.3,
  timeout_sec INTEGER DEFAULT 30,
  max_retries INTEGER DEFAULT 2,
  prompt_template TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

INSERT OR IGNORE INTO config_ai (id) VALUES (1);

CREATE TABLE IF NOT EXISTS config_templates (
  id INTEGER PRIMARY KEY CHECK(id=1),
  movie_folder TEXT DEFAULT '{title} ({year}) {{tmdb-{tmdbId}}}',
  movie_file TEXT DEFAULT '{title} ({year}) - {resolution}.{source}.{videoCodec} {bitDepth}.{audioCount}{audioCodec}-{releaseGroup}',
  tv_show TEXT DEFAULT '{title} ({year}) {{tmdb-{tmdbId}}}',
  tv_season TEXT DEFAULT 'Season {season:02d}',
  tv_episode TEXT DEFAULT '{title} ({year}) - S{season:02d}E{episode:02d}.{resolution}.{source}.{videoCodec} {bitDepth}.{audioCount}{audioCodec}-{releaseGroup}',
  tv_episode_range TEXT DEFAULT '{title} ({year}) - S{season:02d}E{episode_start:02d}-E{episode_end:02d}.{resolution}.{source}.{videoCodec} {bitDepth}.{audioCount}{audioCodec}-{releaseGroup}',
  common_subtitle_suffix TEXT DEFAULT '.{lang}',
  common_multi_version_suffix TEXT DEFAULT ' - v{n}',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

INSERT OR IGNORE INTO config_templates (id) VALUES (1);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','running','completed','cancelled','failed')),
  scan_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  skip_count INTEGER DEFAULT 0,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS task_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER REFERENCES tasks(id),
  media_type TEXT CHECK(media_type IN ('movie','tv','anime')),
  source_path TEXT,
  target_path TEXT,
  target_cid TEXT,
  file_id TEXT,
  file_size INTEGER,
  original_name TEXT,
  new_name TEXT,
  tmdb_id INTEGER,
  season INTEGER,
  episode INTEGER,
  episode_end INTEGER,
  identify_source TEXT,
  overwritten INTEGER DEFAULT 0,
  recycled INTEGER DEFAULT 0,
  duration_ms INTEGER,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS unmatched_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  source_name TEXT,
  media_type_guess TEXT,
  identify_attempts TEXT DEFAULT '[]',
  fail_reason TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 5,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','ignored','resolved')),
  file_ids TEXT DEFAULT '[]',
  parent_cid TEXT,
  thumbnail_path TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS media_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_type TEXT NOT NULL CHECK(media_type IN ('movie','tv','anime')),
  tmdb_id INTEGER NOT NULL,
  season INTEGER,
  episode INTEGER,
  target_cid TEXT,
  file_id TEXT,
  file_path TEXT,
  file_size INTEGER,
  resolution TEXT,
  source TEXT,
  video_codec TEXT,
  audio_codec TEXT,
  dolby INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(media_type, tmdb_id, season, episode, file_id)
);

CREATE TABLE IF NOT EXISTS ignore_fingerprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  fingerprint TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS recycle_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT,
  file_id TEXT,
  file_size INTEGER,
  loser_to TEXT,
  winner_path TEXT,
  winner_size INTEGER,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT CHECK(level IN ('DEBUG','INFO','WARN','ERROR')),
  category TEXT,
  message TEXT,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_task_items_task ON task_items(task_id);
CREATE INDEX IF NOT EXISTS idx_unmatched_status ON unmatched_items(status);
CREATE INDEX IF NOT EXISTS idx_media_library_lookup ON media_library(media_type, tmdb_id, season, episode);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
