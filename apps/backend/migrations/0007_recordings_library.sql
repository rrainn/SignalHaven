-- DVR recording library management (rrainn/SignalHaven#R4-library).
--
-- Adds the columns + indexes required by the library API:
--
--   * `recordings.watched_at` / `recordings.resume_position_seconds` —
--     mark-as-watched + resume-position bookkeeping for the player.
--   * `epg_programs.artwork_url` — optional poster/icon URL surfaced in
--     `GET /api/v1/recordings/:id` (XMLTV `<icon src=...>`).
--   * `series_rules.retention_days` — per-series retention policy that
--     auto-deletes recordings older than N days during enforcement.
--   * Composite indexes on `(channel_id, scheduled_start)` and on
--     `actual_start` so the filtered listing endpoint paginates without
--     a sequential scan.

ALTER TABLE recordings
  ADD COLUMN IF NOT EXISTS watched_at timestamptz;

ALTER TABLE recordings
  ADD COLUMN IF NOT EXISTS resume_position_seconds integer;

ALTER TABLE epg_programs
  ADD COLUMN IF NOT EXISTS artwork_url text;

ALTER TABLE series_rules
  ADD COLUMN IF NOT EXISTS retention_days integer;

CREATE INDEX IF NOT EXISTS recordings_channel_scheduled_start_idx
  ON recordings (channel_id, scheduled_start);

CREATE INDEX IF NOT EXISTS recordings_actual_start_idx
  ON recordings (actual_start);
