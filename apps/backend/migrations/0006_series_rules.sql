-- DVR series rules / season passes (rrainn/SignalHaven#R3-series).
--
-- The `series_rules` table itself was provisioned in 0000 with the bare
-- columns (title, channel scope, keep_count, new_only, priority); this
-- migration adds the bookkeeping timestamps the new repository / API
-- expose, and links recorded files back to the rule that created them.
--
-- `recordings.series_rule_id` lets `keepCount` enforcement walk only
-- the recordings produced by a given rule, and `manually_protected`
-- opts a row out of automatic deletion (the user pinned it).

ALTER TABLE series_rules
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE series_rules
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE recordings
  ADD COLUMN IF NOT EXISTS series_rule_id uuid
    REFERENCES series_rules(id) ON DELETE SET NULL;

ALTER TABLE recordings
  ADD COLUMN IF NOT EXISTS manually_protected boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS recordings_series_rule_idx
  ON recordings (series_rule_id);
