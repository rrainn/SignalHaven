DROP INDEX IF EXISTS epg_sources_hdhomerun_tuner_unique;

-- Managed sources cannot exist without the tuner link on the previous schema.
DELETE FROM epg_sources
  WHERE url IS NULL AND file_path IS NULL;

ALTER TABLE epg_sources
  DROP CONSTRAINT IF EXISTS epg_sources_target;

ALTER TABLE epg_sources
  ADD CONSTRAINT epg_sources_url_or_path CHECK (
    (url IS NOT NULL) OR (file_path IS NOT NULL)
  );

ALTER TABLE epg_sources
  DROP COLUMN IF EXISTS tuner_id;
