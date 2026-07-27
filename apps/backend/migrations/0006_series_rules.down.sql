DROP INDEX IF EXISTS recordings_series_rule_idx;

ALTER TABLE recordings
  DROP COLUMN IF EXISTS manually_protected;

ALTER TABLE recordings
  DROP COLUMN IF EXISTS series_rule_id;

ALTER TABLE series_rules
  DROP COLUMN IF EXISTS updated_at;

ALTER TABLE series_rules
  DROP COLUMN IF EXISTS created_at;
