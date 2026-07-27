DROP INDEX IF EXISTS channels_tuner_provider_channel_id_unique;

ALTER TABLE channels
	DROP COLUMN IF EXISTS provider_channel_id;
