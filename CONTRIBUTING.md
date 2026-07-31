# Contributing

Thanks for contributing to SignalHaven.

## Prerequisites

- Node.js 22+
- pnpm 11.10.0
- Docker + Docker Compose (for local PostgreSQL and container workflows)

## Development setup

```bash
pnpm install --frozen-lockfile
cp .env.example .env
# set PGPASSWORD in .env
```

Start local PostgreSQL:

```bash
docker compose up -d postgres
```

Run backend migrations (optional if using startup auto-migrate):

```bash
pnpm run db:migrate
```

Start the monorepo dev servers:

```bash
pnpm run dev
```

- Root application scripts load the repository `.env` automatically. Existing
  shell environment variables still take precedence.
- Frontend: typically `http://localhost:3000`
- Backend API: `http://localhost:3001` when started by the root development command
- For separate processes, set `PORT=3001` on the backend and
  `SIGNALHAVEN_BACKEND_ORIGIN=http://localhost:3001` on the frontend.

## Resource-bounded frontend preview

Use the safe preview when reviewing the optimized frontend without hot reload.
Unlike `pnpm run dev`, it does not leave a compiler or filesystem watcher active:

```bash
pnpm run preview:safe
```

This command builds with webpack using one static-generation worker and a
768 MB Node heap cap, then starts one production Next.js server with a 512 MB
heap cap. It health-checks `/recordings` before printing the URL, PID, process
count, and current RSS. The default URL is `http://127.0.0.1:3100/recordings`.

Stop only the recorded preview process group with:

```bash
pnpm run preview:stop
```

The stop command verifies the recorded PID, process group, process start time,
and command before sending a signal. A stale state file is removed without
signaling its PID. Server output is written to
`.signalhaven-preview/preview.log`.

For separate build and start steps, use `pnpm run preview:build` followed by
`pnpm run preview:start`. The following environment variables are optional:

- `SIGNALHAVEN_PREVIEW_PORT` (default `3100`)
- `SIGNALHAVEN_PREVIEW_HOST` (default `127.0.0.1`)
- `SIGNALHAVEN_PREVIEW_BUILD_HEAP_MB` (default `768`)
- `SIGNALHAVEN_PREVIEW_SERVER_HEAP_MB` (default `512`)

Run `pnpm install --frozen-lockfile` once from the repository root in a normal checkout or Git
worktree. pnpm links the workspaces from that installation; do not copy a
`node_modules` directory from another checkout. Use `pnpm run dev` only when
you need HMR and accept the additional compiler and watcher resource usage.

## Validation commands

Run before opening a PR:

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
```

Run `pnpm run format` to apply the repository's formatting rules before
committing.

## Project layout

- `apps/backend` — Express backend, DB migrations, streaming/recording services
- `apps/bonjour` — optional Linux DNS-SD advertiser sidecar
- `apps/frontend` — Next.js UI
- `packages/shared` — shared schemas/types

## Pull requests

- Keep changes focused and scoped to one issue.
- Include tests/validation for code changes.
- Update docs when behavior or configuration changes.
