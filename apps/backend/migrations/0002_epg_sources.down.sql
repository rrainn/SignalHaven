DROP INDEX IF EXISTS epg_programs_channel_start_uidx;
DROP INDEX IF EXISTS epg_programs_channel_external_start_uidx;
ALTER TABLE epg_programs DROP COLUMN IF EXISTS external_id;

ALTER TABLE epg_channels DROP CONSTRAINT IF EXISTS epg_channels_source_id_epg_sources_id_fk;
ALTER TABLE epg_channels
  ADD CONSTRAINT epg_channels_source_id_tuners_id_fk
    FOREIGN KEY (source_id) REFERENCES tuners(id) ON DELETE CASCADE;

DROP INDEX IF EXISTS epg_sources_kind_idx;
DROP TABLE IF EXISTS epg_sources;
