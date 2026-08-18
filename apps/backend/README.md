# @signalhaven/backend

## HTTP API

The backend exposes a versioned REST API mounted at `/api/v1`. Common
infrastructure that all endpoints get:

- **Request id** middleware: every request is assigned an `x-request-id`
  (uuid v4); incoming `x-request-id` headers are honored and echoed back.
- **Structured logging** via [`pino`](https://getpino.io/) +
  [`pino-http`](https://github.com/pinojs/pino-http) (request id, method,
  URL, status, response time). Set `LOG_LEVEL` to override (`silent` in
  tests).
- **CORS**: permissive in development, same-origin only in production.
- **JSON body limit** of 1 MB.
- **Mandatory authentication** for every route except health, auth bootstrap/login/status, and API discovery. Protected responses use `Cache-Control: private, no-store` so browser caches cannot cross account switches.
- **Centralized error envelope**:

  ```json
  {
    "error": {
      "code": "...",
      "message": "...",
      "details": {},
      "requestId": "..."
    }
  }
  ```

  Unknown errors become HTTP 500 with the request id as the correlation
  id. `zod` validation failures become HTTP 400 with the issue list under
  `details`.

### Endpoints

- `GET /api/v1/health` — returns service `version`, process `uptime`
  (seconds) and `db.ok` flag. Responds `200` when healthy, `503`
  otherwise.
- `GET /api/v1/openapi.json` — OpenAPI 3.1 specification generated from
  the shared `zod` schemas via
  [`@asteasolutions/zod-to-openapi`](https://github.com/asteasolutions/zod-to-openapi).
- `GET /api/v1/docs` — interactive Swagger UI (development only;
  disabled in production).
- `GET /api/v1/auth/status` — reports independent account-bootstrap and system-setup state, plus the current cookie session when present.
- `POST /api/v1/auth/setup` — atomically activates the one pending administrator. It accepts `{ username, password, transport }` exactly once.
- `POST /api/v1/auth/login`, `GET /api/v1/auth/me`, and `POST /api/v1/auth/logout` — create, inspect, and revoke sessions.
- `GET|POST /api/v1/users` — administrator-only account listing and standard-user creation.
- `GET|PATCH /api/v1/preferences` — the current user's `ui`, `channels`, and `player` groups.
- `GET|PATCH /api/v1/settings` — administrator-only global machine configuration.
- `POST /api/v1/stream/:channelId/media-ticket` and `POST /api/v1/recordings/:id/media-ticket` — issue session-bound HLS playback URLs for native clients.

Browser setup/login requests use `transport: "cookie"` and receive a 30-day opaque session in an HttpOnly, SameSite=Strict cookie. Cookie mutations require a complete same-scheme, same-host Origin match; `Secure` follows the actual HTTPS request, including trusted loopback reverse-proxy headers. Native Apple clients use `transport: "bearer"` and receive the same opaque session token in the response body. The database stores only SHA-256 token digests, while passwords use salted scrypt hashes. Authentication endpoints are process-local rate limited; multi-replica deployments must enforce an equivalent shared or proxy limit.

WebSocket event connections authenticate with the same cookie or bearer session. Cookie upgrades enforce the same origin policy, audiences are filtered per account/role, and heartbeat revalidation closes expired or revoked sessions with code `4401`.

Shared request/response schemas live in `packages/shared` so backend and
frontend can import them.

## Database layer

The backend uses **PostgreSQL 14+** with:

- [`pg`](https://www.npmjs.com/package/pg) for pooled connections (`pg.Pool`)
- [`drizzle-orm`](https://orm.drizzle.team/) for typed schema/repository queries
- [`drizzle-kit`](https://orm.drizzle.team/docs/drizzle-kit-overview) for SQL migrations in `apps/backend/migrations`

This combination gives us a typed data-access layer plus explicit SQL migrations that can be applied in CI, local dev, and production.

## Connection configuration

Preferred:

- `SIGNALHAVEN_DATABASE_URL=postgres://signalhaven:signalhaven@localhost:5432/signalhaven`

Fallback discrete variables (used when `SIGNALHAVEN_DATABASE_URL` is unset):

- `PGHOST`
- `PGPORT` (default `5432`)
- `PGUSER`
- `PGPASSWORD`
- `PGDATABASE`

Optional tuning:

- `SIGNALHAVEN_DATABASE_POOL_MAX` (default `10`)
- `SIGNALHAVEN_DB_STATEMENT_TIMEOUT_MS` (default `30000`)
- `SIGNALHAVEN_DB_IDLE_IN_TX_TIMEOUT_MS` (default `30000`)
- `SIGNALHAVEN_DB_AUTO_MIGRATE` (default `true`; set `false` to disable startup migrations)

All timestamps are stored as UTC `timestamptz`.

## Migrations

- Automatic at backend startup unless `SIGNALHAVEN_DB_AUTO_MIGRATE=false`
- Manual run: `pnpm --filter @signalhaven/backend db:migrate`
- Migration files: `apps/backend/migrations`

Migration `0020_user_accounts.sql` creates an unactivated bootstrap administrator and atomically assigns every existing recording, series rule, and former global `ui`/`channels`/`player` preference to it. An upgraded configured install therefore asks for an administrator account on the next visit without losing its existing library. The down migration refuses to run after any additional activated account exists because the legacy schema cannot preserve those account records or preferences.

## Local development with Docker Compose

A local Postgres service is provided at the repository root:

```bash
docker compose up -d postgres
```

Connection string:

```bash
postgres://signalhaven:signalhaven@localhost:5432/signalhaven
```
