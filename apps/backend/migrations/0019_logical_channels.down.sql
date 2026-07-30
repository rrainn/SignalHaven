ALTER TABLE series_rules
	DROP CONSTRAINT series_rules_channel_id_fkey,
	ADD CONSTRAINT series_rules_channel_id_fkey
		FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL;

ALTER TABLE recordings
	DROP CONSTRAINT recordings_channel_id_fkey,
	ADD CONSTRAINT recordings_channel_id_fkey
		FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
	DROP COLUMN source_channel_id;

DROP TABLE logical_channel_epg_map;
DROP INDEX channels_logical_priority_idx;

ALTER TABLE channels
	DROP CONSTRAINT channels_source_status_check,
	DROP CONSTRAINT channels_logical_channel_id_fkey,
	DROP COLUMN source_priority,
	DROP COLUMN source_status,
	DROP COLUMN logical_channel_id;

DROP TABLE logical_channels;
