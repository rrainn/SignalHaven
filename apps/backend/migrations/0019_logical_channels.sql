-- Separate the channel users manage from the tuner-specific sources that carry it.
CREATE TABLE logical_channels (
	id uuid PRIMARY KEY,
	number text NOT NULL,
	name text NOT NULL,
	logo_url text,
	enabled boolean NOT NULL DEFAULT true,
	sort_order integer NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

-- Preserve every existing public channel id during the one-to-one backfill.
INSERT INTO logical_channels (id, number, name, logo_url, enabled, sort_order)
SELECT id, number, name, logo_url, enabled, sort_order
FROM channels;

CREATE INDEX logical_channels_sort_idx ON logical_channels (sort_order);

ALTER TABLE channels
	ADD COLUMN logical_channel_id uuid,
	ADD COLUMN source_status text NOT NULL DEFAULT 'active',
	ADD COLUMN source_priority integer NOT NULL DEFAULT 0;

UPDATE channels
SET logical_channel_id = id;

ALTER TABLE channels
	ALTER COLUMN logical_channel_id SET NOT NULL,
	ADD CONSTRAINT channels_logical_channel_id_fkey
		FOREIGN KEY (logical_channel_id) REFERENCES logical_channels(id) ON DELETE CASCADE,
	ADD CONSTRAINT channels_source_status_check
		CHECK (source_status IN ('active', 'missing', 'unavailable'));

CREATE INDEX channels_logical_priority_idx
	ON channels (logical_channel_id, source_priority, id);

-- Keep tuner-specific matching while selecting one guide feed per logical channel.
CREATE TABLE logical_channel_epg_map (
	logical_channel_id uuid PRIMARY KEY REFERENCES logical_channels(id) ON DELETE CASCADE,
	epg_channel_id uuid NOT NULL REFERENCES epg_channels(id) ON DELETE CASCADE,
	manual boolean NOT NULL DEFAULT false
);

INSERT INTO logical_channel_epg_map (logical_channel_id, epg_channel_id, manual)
SELECT c.logical_channel_id, m.epg_channel_id, m.manual
FROM channel_epg_map m
JOIN channels c ON c.id = m.channel_id;

-- Scheduled objects now follow the logical channel across source changes.
ALTER TABLE recordings
	ADD COLUMN source_channel_id uuid REFERENCES channels(id) ON DELETE SET NULL;

UPDATE recordings
SET source_channel_id = channel_id;

ALTER TABLE recordings
	DROP CONSTRAINT recordings_channel_id_fkey,
	ADD CONSTRAINT recordings_channel_id_fkey
		FOREIGN KEY (channel_id) REFERENCES logical_channels(id) ON DELETE RESTRICT;

ALTER TABLE series_rules
	DROP CONSTRAINT series_rules_channel_id_fkey,
	ADD CONSTRAINT series_rules_channel_id_fkey
		FOREIGN KEY (channel_id) REFERENCES logical_channels(id) ON DELETE SET NULL;
