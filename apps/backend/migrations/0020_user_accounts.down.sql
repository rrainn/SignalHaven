-- Refuse to silently erase accounts that cannot exist in the legacy schema.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM users
		WHERE id <> '00000000-0000-4000-8000-000000000001'
		  AND activated_at IS NOT NULL
	) THEN
		RAISE EXCEPTION 'cannot remove account support while non-bootstrap users exist';
	END IF;

	-- A down migration cannot safely merge two active recordings for one airing.
	IF EXISTS (
		SELECT program_id
		FROM recordings
		WHERE program_id IS NOT NULL AND status IN ('scheduled', 'recording')
		GROUP BY program_id
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'cannot remove account ownership while users have duplicate active program recordings';
	END IF;
END $$;

DROP TABLE media_tickets;

DROP INDEX recordings_active_program_unique;
CREATE UNIQUE INDEX recordings_active_program_unique
	ON recordings (program_id)
	WHERE program_id IS NOT NULL AND status IN ('scheduled', 'recording');

DROP INDEX series_rules_user_id_idx;
ALTER TABLE series_rules
	DROP CONSTRAINT series_rules_user_id_fkey,
	DROP COLUMN user_id;

DROP INDEX recordings_user_id_idx;
ALTER TABLE recordings
	DROP CONSTRAINT recordings_user_id_fkey,
	DROP COLUMN user_id;

-- Restore the original admin's preferences to the legacy global keys.
INSERT INTO settings (key, value)
SELECT key, value
FROM user_preferences
WHERE user_id = '00000000-0000-4000-8000-000000000001'
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

DROP TABLE user_preferences;
DROP TABLE sessions;
DROP TABLE users;
