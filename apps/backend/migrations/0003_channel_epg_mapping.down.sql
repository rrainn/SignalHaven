ALTER TABLE channel_epg_map DROP COLUMN IF EXISTS manual;

DROP INDEX IF EXISTS channels_tvg_id_idx;
ALTER TABLE channels DROP COLUMN IF EXISTS tvg_id;
