DROP INDEX IF EXISTS recordings_status_scheduled_start_idx;
DROP INDEX IF EXISTS epg_programs_search_tsv_idx;
DROP INDEX IF EXISTS epg_programs_epg_channel_start_idx;
DROP INDEX IF EXISTS channels_tuner_sort_idx;

DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS series_rules;
DROP TABLE IF EXISTS recordings;
DROP TABLE IF EXISTS channel_epg_map;
DROP TABLE IF EXISTS epg_programs;
DROP TABLE IF EXISTS epg_channels;
DROP TABLE IF EXISTS channels;
DROP TABLE IF EXISTS tuners;
