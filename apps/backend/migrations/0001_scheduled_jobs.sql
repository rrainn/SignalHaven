CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 1,
  last_error text,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scheduled_jobs_status_run_at_idx ON scheduled_jobs (status, run_at);
CREATE INDEX IF NOT EXISTS scheduled_jobs_kind_idx ON scheduled_jobs (kind);
