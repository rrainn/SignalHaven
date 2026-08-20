-- Keep one unactivated admin as the owner while an upgraded install awaits setup.
CREATE TABLE users (
	id uuid PRIMARY KEY,
	username text,
	username_normalized text,
	password_hash text,
	role text NOT NULL,
	activated_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT users_role_check CHECK (role IN ('admin', 'user')),
	CONSTRAINT users_activation_complete_check CHECK (
		(activated_at IS NULL AND username IS NULL AND username_normalized IS NULL AND password_hash IS NULL AND role = 'admin')
		OR
		(activated_at IS NOT NULL AND username IS NOT NULL AND username_normalized IS NOT NULL AND password_hash IS NOT NULL)
	)
);

CREATE UNIQUE INDEX users_username_normalized_unique
	ON users (username_normalized)
	WHERE username_normalized IS NOT NULL;

INSERT INTO users (id, role)
VALUES ('00000000-0000-4000-8000-000000000001', 'admin');

CREATE TABLE sessions (
	id uuid PRIMARY KEY,
	user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	token_hash text NOT NULL,
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX sessions_token_hash_unique ON sessions (token_hash);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE user_preferences (
	user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	key text NOT NULL,
	value jsonb NOT NULL,
	PRIMARY KEY (user_id, key),
	CONSTRAINT user_preferences_key_check CHECK (key IN ('ui', 'channels', 'player'))
);

-- Move the former global preferences to the pending admin without losing upgrades.
INSERT INTO user_preferences (user_id, key, value)
VALUES
	(
		'00000000-0000-4000-8000-000000000001',
		'ui',
		COALESCE((SELECT value FROM settings WHERE key = 'ui'), '{"theme":"system","epgHoursVisible":4,"use24HourClock":false,"density":"comfortable","animations":true}'::jsonb)
	),
	(
		'00000000-0000-4000-8000-000000000001',
		'channels',
		COALESCE((SELECT value FROM settings WHERE key = 'channels'), '{"favorites":[],"hidden":[],"order":[]}'::jsonb)
	),
	(
		'00000000-0000-4000-8000-000000000001',
		'player',
		COALESCE((SELECT value FROM settings WHERE key = 'player'), '{"volume":1,"muted":false,"captionsEnabled":false,"qualityByChannel":{}}'::jsonb)
	);

DELETE FROM settings WHERE key IN ('ui', 'channels', 'player');

ALTER TABLE recordings ADD COLUMN user_id uuid;
UPDATE recordings SET user_id = '00000000-0000-4000-8000-000000000001';
ALTER TABLE recordings
	ALTER COLUMN user_id SET NOT NULL,
	ADD CONSTRAINT recordings_user_id_fkey
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
CREATE INDEX recordings_user_id_idx ON recordings (user_id);

ALTER TABLE series_rules ADD COLUMN user_id uuid;
UPDATE series_rules SET user_id = '00000000-0000-4000-8000-000000000001';
ALTER TABLE series_rules
	ALTER COLUMN user_id SET NOT NULL,
	ADD CONSTRAINT series_rules_user_id_fkey
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
CREATE INDEX series_rules_user_id_idx ON series_rules (user_id);

-- Different users may schedule the same guide airing independently.
DROP INDEX recordings_active_program_unique;
CREATE UNIQUE INDEX recordings_active_program_unique
	ON recordings (user_id, program_id)
	WHERE program_id IS NOT NULL AND status IN ('scheduled', 'recording');

CREATE TABLE media_tickets (
	token_hash text PRIMARY KEY,
	session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	resource_kind text NOT NULL,
	resource_id text NOT NULL,
	claims jsonb NOT NULL,
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT media_tickets_resource_kind_check CHECK (resource_kind IN ('live', 'recording'))
);

CREATE INDEX media_tickets_session_id_idx ON media_tickets (session_id);
CREATE INDEX media_tickets_user_id_idx ON media_tickets (user_id);
CREATE INDEX media_tickets_expires_at_idx ON media_tickets (expires_at);
