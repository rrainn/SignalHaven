ALTER TABLE channels
	ADD COLUMN lineup_missing_count integer NOT NULL DEFAULT 0;

ALTER TABLE tuners
	ADD COLUMN last_lineup_sync_at timestamptz,
	ADD COLUMN last_lineup_sync_status text,
	ADD COLUMN last_lineup_sync_error text;

