ALTER TABLE channels
	ADD COLUMN provider_channel_id text;

-- A provider channel may move, but its provider-owned identity must remain unique.
CREATE UNIQUE INDEX channels_tuner_provider_channel_id_unique
	ON channels (tuner_id, provider_channel_id)
	WHERE provider_channel_id IS NOT NULL;
