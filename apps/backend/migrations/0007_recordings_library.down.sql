DROP INDEX IF EXISTS recordings_actual_start_idx;
DROP INDEX IF EXISTS recordings_channel_scheduled_start_idx;

ALTER TABLE series_rules
  DROP COLUMN IF EXISTS retention_days;

ALTER TABLE epg_programs
  DROP COLUMN IF EXISTS artwork_url;

ALTER TABLE recordings
  DROP COLUMN IF EXISTS resume_position_seconds;

ALTER TABLE recordings
  DROP COLUMN IF EXISTS watched_at;
