-- One-off recordings (rrainn/SignalHaven#R1-oneoff) augment the existing
-- `recordings` table with the columns required by the new DVR
-- primitive: a user-facing `title` (used to build the on-disk file
-- name), the actual recorded duration once playback metadata is
-- probed, and bookkeeping `created_at` / `updated_at` columns to match
-- the rest of the schema.
ALTER TABLE recordings
  ADD COLUMN IF NOT EXISTS title text;

-- Existing rows (from earlier seed data, if any) get a placeholder so
-- the NOT NULL constraint can be applied.
UPDATE recordings SET title = '' WHERE title IS NULL;

ALTER TABLE recordings
  ALTER COLUMN title SET NOT NULL;

ALTER TABLE recordings
  ADD COLUMN IF NOT EXISTS duration_seconds integer;

ALTER TABLE recordings
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE recordings
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
