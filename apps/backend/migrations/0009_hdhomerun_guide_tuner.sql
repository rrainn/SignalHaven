ALTER TABLE epg_sources
  ADD COLUMN IF NOT EXISTS tuner_id uuid
    REFERENCES tuners(id) ON DELETE CASCADE;

ALTER TABLE epg_sources
  DROP CONSTRAINT IF EXISTS epg_sources_url_or_path;

ALTER TABLE epg_sources
  ADD CONSTRAINT epg_sources_target CHECK (
    (url IS NOT NULL) OR (file_path IS NOT NULL) OR (tuner_id IS NOT NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS epg_sources_hdhomerun_tuner_unique
  ON epg_sources (tuner_id)
  WHERE tuner_id IS NOT NULL;
