ALTER TABLE recordings
  DROP COLUMN IF EXISTS updated_at;

ALTER TABLE recordings
  DROP COLUMN IF EXISTS created_at;

ALTER TABLE recordings
  DROP COLUMN IF EXISTS duration_seconds;

ALTER TABLE recordings
  DROP COLUMN IF EXISTS title;
