ALTER TABLE tuners
	DROP COLUMN IF EXISTS last_lineup_sync_error,
	DROP COLUMN IF EXISTS last_lineup_sync_status,
	DROP COLUMN IF EXISTS last_lineup_sync_at;

ALTER TABLE channels
	DROP COLUMN IF EXISTS lineup_missing_count;
