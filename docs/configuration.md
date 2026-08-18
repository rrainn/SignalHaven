# Configuration reference

This document covers runtime environment variables and persisted Settings values.

## Advanced mode

Advanced mode is a browser-local troubleshooting preference under
**Settings → Appearance**. SignalHaven stores it as `signalhaven.advanced-mode.v1` in the
browser's local storage, so enabling it does not affect other browsers or
users of the same server.

When enabled, the UI adds:

- an **Advanced** page listing active live-stream and recording FFmpeg work,
  including controls that gracefully stop individual processes;
- on-demand HDHomeRun signal-strength, signal-quality, symbol-quality, lock,
  and network-rate measurements on the Channels page (measurements are
  available only while the requested channel is actively tuned);
- a video context-menu action named **Show Extra Stats**, with bitrate,
  resolution, FPS, dropped frames, buffer health, buffering event count and
  average/minimum/maximum durations, latency, transcode profile,
  hardware acceleration, and server session information; and
- server error codes, request IDs, HTTP status, and playback diagnostics in
  client-facing errors.

Stopping recording FFmpeg work cancels that recording and preserves the
normal recording cancellation semantics. The browser-local Advanced mode flag
is only a visibility preference; the backend independently requires an
administrator session for every advanced diagnostic and machine-topology API.
See [Local accounts and sessions](accounts.md) for the wider deployment boundary.

The Advanced page can also show the server's public IP address. This lookup is
disabled by default because enabling it sends the server's public IP and normal
HTTP request metadata to `ip.rrainn.space`. Set
`SIGNALHAVEN_EXTERNAL_IP_LOOKUP_ENABLED=true` to opt in. The lookup runs when
the page opens and when an operator manually refreshes it; it is not polled.

## Guide data

HDHomeRun guide sources are created automatically when a tuner is added. At
refresh time, SignalHaven reads `discover.json` from the configured tuner and uses
its current `DeviceAuth` to request SiliconDust's supported XMLTV guide feed.
The rotating token is kept in memory for that request and is not persisted or
returned by the API. A paid HDHomeRun DVR guide subscription is required by
SiliconDust for this feed.

An IPTV tuner's optional EPG URL is automatically managed as an XMLTV source
owned by that tuner. Automatic channel matching stays within the tuner-owned
source and prefers the playlist's `tvg-id`; existing unlinked XMLTV sources
with the same URL are adopted during upgrade. Additional shared XMLTV sources
and local XMLTV files remain available under **Settings → EPG Sources**.

## Environment variables

### Shared `.env`

Root application scripts and Docker Compose read the same `.env` file. Compose
maps the backend-compatible `PG*` names to the `POSTGRES_*` names required by
the official Postgres image.

| Variable                                 | Default                                     | Description                                                  |
| ---------------------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| `PGHOST`                                 | `localhost`                                 | Database host used by local backend scripts.                 |
| `PGPORT`                                 | `5432`                                      | Database port used locally and bound to loopback by Compose. |
| `PGDATABASE`                             | `signalhaven`                               | Database name for the backend and bundled Postgres service.  |
| `PGUSER`                                 | `signalhaven`                               | Database user for the backend and bundled Postgres service.  |
| `PGPASSWORD`                             | `change-me`                                 | Database password for the backend and bundled Postgres.      |
| `SIGNALHAVEN_IMAGE`                      | `ghcr.io/rrainn/signalhaven:latest`         | Container image reference used by the `signalhaven` service. |
| `SIGNALHAVEN_BONJOUR_IMAGE`              | `ghcr.io/rrainn/signalhaven-bonjour:latest` | Optional Linux DNS-SD sidecar image.                         |
| `SIGNALHAVEN_HTTP_PORT`                  | `3000`                                      | Loopback-only host port used by the HTTPS reverse proxy.     |
| `PUBLIC_URL`                             | _required for Bonjour_                      | Canonical HTTPS base URL advertised to discovered clients.   |
| `SIGNALHAVEN_SERVICE_NAME`               | `SignalHaven`                               | Human-readable Bonjour service name.                         |
| `SIGNALHAVEN_SERVER_ID`                  | _generated_                                 | Optional stable Bonjour UUID override.                       |
| `SIGNALHAVEN_BONJOUR_INTERFACES`         | _all eligible_                              | Optional comma-separated Linux interfaces or addresses.      |
| `SIGNALHAVEN_BONJOUR_DISABLE_IPV6`       | `false`                                     | Disable Bonjour IPv6 address records.                        |
| `SIGNALHAVEN_COMSKIP_PATH`               | `/usr/bin/comskip`                          | Comskip executable path inside the backend container.        |
| `SIGNALHAVEN_EXTERNAL_IP_LOOKUP_ENABLED` | `false`                                     | Opt in to the Advanced-page external IP lookup.              |

### Backend runtime

| Variable                                                     | Default                                                         | Description                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `PORT`                                                       | `3000`                                                          | Backend HTTP port.                                                               |
| `NODE_ENV`                                                   | `development`                                                   | Runtime environment (`development`, `test`, `production`).                       |
| `LOG_LEVEL`                                                  | `info` (`silent` in test)                                       | Pino log level.                                                                  |
| `LOG_FILE`                                                   | _unset_                                                         | Enables rotating file logging when set (also logs to stdout).                    |
| `LOG_ROTATE_FREQUENCY`                                       | `daily`                                                         | Rotation frequency for `LOG_FILE` (`daily`, `hourly`, `minutely`, or size).      |
| `LOG_MAX_FILES`                                              | `7`                                                             | Number of rotated log files to retain.                                           |
| `SIGNALHAVEN_DATABASE_URL`                                   | `postgres://signalhaven:signalhaven@localhost:5432/signalhaven` | Primary PostgreSQL connection string.                                            |
| `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` | _unset_                                                         | Fallback discrete DB settings when `SIGNALHAVEN_DATABASE_URL` is not set.        |
| `SIGNALHAVEN_DATABASE_POOL_MAX`                              | `10`                                                            | Maximum DB pool size.                                                            |
| `SIGNALHAVEN_DB_STATEMENT_TIMEOUT_MS`                        | `30000`                                                         | PostgreSQL statement timeout in ms.                                              |
| `SIGNALHAVEN_DB_IDLE_IN_TX_TIMEOUT_MS`                       | `30000`                                                         | Idle-in-transaction timeout in ms.                                               |
| `SIGNALHAVEN_DB_AUTO_MIGRATE`                                | `true`                                                          | Run DB migrations at startup.                                                    |
| `SIGNALHAVEN_COMSKIP_PATH`                                   | `/usr/bin/comskip`                                              | Override the bundled Comskip executable path.                                    |
| `SIGNALHAVEN_EXTERNAL_IP_LOOKUP_ENABLED`                     | `false`                                                         | Contacts `ip.rrainn.space` to show the server public IP when explicitly enabled. |

Live-stream startup failures emit one structured `error` record containing
the public channel and provider IDs, transcode profile, hardware-acceleration
mode, FFmpeg exit status, and a sanitized diagnostic. Upstream URLs,
credentials, and secret-bearing query parameters are omitted from this record;
the player receives only generic playback error copy.

Recording-playback preparation failures follow the same safe logging contract.
Their terminal record includes the initiating request ID when available, the
recording and playback-session IDs, the selected profile and hardware mode,
and the classified FFmpeg exit details. Recoverable hardware attempts that
successfully fall back to software do not produce a terminal error record.
The Advanced FFmpeg list reports viewer counts per opaque playback session;
stopping one session does not interrupt viewers using a different seek window.

### Frontend runtime

| Variable                     | Default                 | Description                                                 |
| ---------------------------- | ----------------------- | ----------------------------------------------------------- |
| `SIGNALHAVEN_BACKEND_ORIGIN` | `http://localhost:3000` | Dev/proxy backend origin used by Next.js `/api/*` rewrites. |
| `NEXT_PUBLIC_API_BASE_URL`   | _empty_                 | Optional API base URL override for frontend requests.       |
| `NEXT_PUBLIC_DISABLE_SW`     | _unset_                 | Set to `1` to disable service worker registration.          |

### Test and CI helpers

| Variable                   | Default | Description                                                   |
| -------------------------- | ------- | ------------------------------------------------------------- |
| `COVERAGE_LINES_THRESHOLD` | `70`    | Backend line-coverage threshold for `test:coverage`.          |
| `SIGNALHAVEN_RUN_PERF`     | `0`     | Enables optional backend perf test blocks when set to truthy. |

## Settings object

Administrator-only `GET /api/v1/settings` returns the persisted global machine
settings document with these top-level keys. Account-specific `ui`, `channels`,
and `player` values are returned and patched through `/api/v1/preferences`;
changing them never affects another user.

### `storage`

| Key       | Type             | Default | Description                                                                                                                                                          |
| --------- | ---------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`    | `string \| null` | `null`  | Absolute recordings directory path.                                                                                                                                  |
| `quotaGb` | `number \| null` | `null`  | Global completed-recordings ceiling in GB (`null` = unlimited). Cleanup measures all accounts but deletes only from the account whose new media crossed the ceiling. |

### `transcoding`

Browser and Apple clients use `profile=auto` (also the public behavior when
`profile` is omitted) to request one channel-keyed adaptive session. That
session acquires one tuner/source ingest and publishes synchronized 1080p,
720p, and 480p renditions when those sizes do not upscale the source. Broadcast
interlacing is removed once before the rendition split, and outputs use atomic
two-second fragmented-MP4 HLS segments with H.264/AAC. Explicit profile values remain locked
recovery options. A synthetic complete-graph benchmark must sustain 1.25× real
time before Adaptive Streaming is available. Once live, five consecutive
samples that are actually falling behind wall clock stop with an actionable
`encoder_capacity` error.

| Key                 | Type                                                                            | Default      | Description                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`           | `boolean`                                                                       | `false`      | Enables/disables transcoding.                                                                                                                                    |
| `preset`            | `"fast" \| "balanced" \| "quality"`                                             | `"balanced"` | Encoder preset profile.                                                                                                                                          |
| `videoBitrateKbps`  | `number`                                                                        | `4000`       | Target video bitrate in kbps.                                                                                                                                    |
| `audioBitrateKbps`  | `number`                                                                        | `192`        | Target audio bitrate in kbps.                                                                                                                                    |
| `defaultProfile`    | `"direct" \| "original-quality" \| "1080p" \| "720p" \| "480p" \| "audio-only"` | `"direct"`   | Default locked profile for internal/manual playback; public requests without a profile use Adaptive Streaming.                                                   |
| `hwaccel`           | `"auto" \| "none" \| "videotoolbox" \| "vaapi" \| "qsv" \| "nvenc"`             | `"auto"`     | Hardware acceleration preference.                                                                                                                                |
| `availableHwaccels` | `HwaccelKind[]`                                                                 | `[]`         | Backends the SignalHaven process successfully initialized and used to encode a synthetic frame. Probes are bounded, and failures fall back to software encoding. |
| `captionsEnabled`   | `boolean`                                                                       | `true`       | Enables sidecar closed-caption extraction for streams.                                                                                                           |

#### NVIDIA GPU acceleration

On an NVIDIA Docker host, grant the SignalHaven service GPU access and expose the
driver capabilities required by CUDA decoding and NVENC encoding:

```yaml
services:
  signalhaven:
    gpus: all
    environment:
      NVIDIA_VISIBLE_DEVICES: ${SIGNALHAVEN_NVIDIA_VISIBLE_DEVICES:-all}
      NVIDIA_DRIVER_CAPABILITIES: ${SIGNALHAVEN_NVIDIA_DRIVER_CAPABILITIES:-video,compute,utility}
```

SignalHaven's `auto` hardware preference selects NVENC ahead of integrated Linux GPU
backends when all are usable. To require NVIDIA explicitly, select `nvenc` in
**Settings → Transcoding → Hardware acceleration**. Select a profile that
re-encodes video, such as `1080p` or `720p`; the default `direct` profile and
DVR capture use FFmpeg stream copy, which intentionally does not engage a video
encoder or the GPU. Recording playback also stream-copies browser-compatible
H.264/AAC and uses the selected hardware backend only when conversion is needed.

### `ui`

| Key               | Type                            | Default         | Description                                                                      |
| ----------------- | ------------------------------- | --------------- | -------------------------------------------------------------------------------- |
| `theme`           | `"light" \| "dark" \| "system"` | `"system"`      | UI color theme mode.                                                             |
| `epgHoursVisible` | `number` (`1..24`)              | `4`             | Guide hours requested and rendered from the current window start.                |
| `use24HourClock`  | `boolean`                       | `false`         | Use 24-hour formatting for guide, watch, search, scheduler, and recording times. |
| `density`         | `"comfortable" \| "compact"`    | `"comfortable"` | Spacing density for shared layouts, cards, tabs, and controls.                   |
| `animations`      | `boolean`                       | `true`          | Enables non-essential UI animations/transitions.                                 |

### `recordings`

| Key                                   | Type                | Default          | Description                                                       |
| ------------------------------------- | ------------------- | ---------------- | ----------------------------------------------------------------- |
| `paddingBeforeSec`                    | integer (`0..3600`) | `0`              | Start-recording padding before scheduled start.                   |
| `paddingAfterSec`                     | integer (`0..3600`) | `0`              | End-recording padding after scheduled stop.                       |
| `commercialDetection.enabled`         | boolean             | `false`          | Queues analysis after successful recordings.                      |
| `commercialDetection.detectorVersion` | string              | `comskip-edl-v1` | Configuration revision; changing it regenerates existing markers. |

Pre-padding is stored in the scheduler job when a recording is created or
rescheduled, so changing it does not rewrite existing pending jobs.
Post-padding is resolved when a capture attempt starts and establishes that
attempt's absolute cutoff. Pending recordings therefore use the latest
post-padding when they start, while an in-progress recording keeps the cutoff
it already calculated.

#### Commercial detection

Commercial detection is optional and off until it is enabled under
**Settings → Storage & DVR → Commercial detection**. The Docker image includes
Comskip 0.82.x at `/usr/bin/comskip` and a SignalHaven configuration that enables
EDL output. SignalHaven discards Comskip's raw files after each run and stores only
validated millisecond marker intervals in PostgreSQL.

Set `SIGNALHAVEN_COMSKIP_PATH` only when a custom Comskip binary is mounted at a
different in-container path. SignalHaven runs at most one commercial detector at
a time. Recording and playback success do not depend on detector success, and a
recording detail page can run Comskip for older media, retry a failure, or rerun
a completed analysis. Active work remains idempotent, so repeated requests do
not create concurrent jobs for the same recording. Change `detectorVersion`
when updating Comskip or its configuration to queue safe regeneration for
completed recordings automatically.

If analysis reports that no EDL was produced, verify that the bundled configuration
is present and that the SignalHaven process can execute Comskip. For an exit-code
failure, run the same binary as the SignalHaven service user and confirm it can read
the recordings directory. Temporary detector output uses the operating-system temporary
directory and is removed after completion, failure, cancellation, and recording
deletion.

### `timeShift`

| Key                | Type                | Default | Description                                                        |
| ------------------ | ------------------- | ------- | ------------------------------------------------------------------ |
| `enabled`          | `boolean`           | `true`  | Enables the rolling pause/rewind buffer for new live sessions.     |
| `bufferPath`       | `string \| null`    | `null`  | Disposable buffer directory; `null` uses the system temp location. |
| `durationMinutes`  | integer (`1..240`)  | `60`    | Retained seek window for each active channel session.              |
| `maxDiskGb`        | positive number     | `10`    | Aggregate hard allowance across live time-shift sessions.          |
| `idleGraceSeconds` | integer (`0..3600`) | `30`    | Buffer reuse period after the last viewer leaves a channel.        |

Time-shift media has a separate lifecycle from recordings. FFmpeg publishes
segments and manifests atomically, advances a bounded playlist, and deletes
expired segments. Adaptive clients using the same channel join one session,
one upstream ingest, and one tuner lease. Explicit manual profiles remain
separate locked sessions.
When the last viewer leaves, the buffer remains available for the configured
idle grace period and is then deleted; switching channels therefore keeps the
old buffer only for that grace period. Startup cleanup and normal shutdown remove
session directories, and the global disk monitor drops an idle buffer first if
the allowance is crossed. If time-shifting is disabled, SignalHaven uses the original
short six-segment low-latency playlist.

### `lineupSync`

| Key                | Type               | Default | Description                                                     |
| ------------------ | ------------------ | ------- | --------------------------------------------------------------- |
| `enabled`          | `boolean`          | `true`  | Enables recurring imports of every configured tuner lineup.     |
| `intervalHours`    | integer (`1..168`) | `24`    | Minimum time between successful imports for the same tuner.     |
| `removalThreshold` | integer (`2..10`)  | `3`     | Successful misses before a retained source becomes unavailable. |

The scheduler checks hourly and imports each tuner when its configured cadence
is due. Both automatic imports and the manual **Sync channels** action invalidate
the provider's lineup cache first. Failed fetches do not change channels or
advance missing-channel counters, and they retry on the next hourly check.
Existing channel IDs, preferences, group membership, and EPG mappings survive
updates. A source that returns before reaching `removalThreshold` has its miss
count reset. At the threshold it is excluded from Guide and automatic source
selection, but remains attached to its logical channel so a later return can
recover without rebuilding preferences. Explicitly separating the source or
deleting its tuner is what removes it from the group.

## Series recording retention

Series rules also carry an `episodePolicy`:

| Value             | Behavior                                                                |
| ----------------- | ----------------------------------------------------------------------- |
| `all`             | Records every uniquely identified episode or airing.                    |
| `confirmed_new`   | Records only provider-confirmed new broadcasts and premieres.           |
| `new_and_unknown` | Also records broadcasts whose provider supplies no newness information. |

SignalHaven reads XMLTV `new`, `premiere`, `previously-shown`, original-air-date,
and stable episode-number metadata. Missing evidence remains `unknown`; a short
local guide window is never treated as proof that an episode is new. The legacy
`newOnly` API field remains as a compatibility projection while clients migrate
to `episodePolicy`.

Each series rule has two independent retention controls:

| Key             | Type                           | Default | Description                                                                     |
| --------------- | ------------------------------ | ------- | ------------------------------------------------------------------------------- |
| `keepCount`     | integer (`1..1000`)            | `5`     | Keeps the newest N unprotected recordings and removes older extras.             |
| `retentionDays` | integer (`1..36500`) or `null` | `null`  | Removes unprotected recordings older than N days; `null` disables age eviction. |

When both controls are configured, SignalHaven removes an unprotected recording as
soon as either condition requires it—the first applicable limit wins. A
`retentionDays` value of `null`, including rules created before age retention
was exposed in the UI, means there is no age limit; `keepCount` still applies.
Protected recordings are excluded from both policies and from storage-quota
eviction.

### `channels`

| Key         | Type               | Default | Description                                                  |
| ----------- | ------------------ | ------- | ------------------------------------------------------------ |
| `favorites` | `string[]` (UUIDs) | `[]`    | Favorited IDs, ranked before non-favorites.                  |
| `hidden`    | `string[]` (UUIDs) | `[]`    | IDs excluded from Guide and normal navigation.               |
| `order`     | `string[]` (UUIDs) | `[]`    | Manual base order used consistently across channel surfaces. |

Channel ordering is deterministic: hidden/disabled channels are excluded from
normal navigation, favorites form the first rank, and `order` is preserved
inside both the favorite and non-favorite ranks. Channels missing from `order`
fall back to the server-provided canonical order.

### `player`

| Key                | Type                         | Default | Description                             |
| ------------------ | ---------------------------- | ------- | --------------------------------------- |
| `volume`           | `number` (`0..1`)            | `1`     | Last player volume.                     |
| `muted`            | `boolean`                    | `false` | Last player muted state.                |
| `captionsEnabled`  | `boolean`                    | `false` | Last player captions toggle.            |
| `qualityByChannel` | `Record<channelId, profile>` | `{}`    | Per-channel transcode profile override. |

### `observability`

`POST /api/v1/playback/telemetry` accepts only bounded playback event, client,
profile, cause, duration, buffer, latency, and pipeline values. The self-hosted
server converts these into low-cardinality Prometheus metrics and deliberately
does not accept channel IDs, viewer IDs, or URLs. Playback startup, rebuffer
count/duration/ratio, rendition changes, fatal errors, and live latency are
available from `/api/v1/metrics`.

| Key                  | Type      | Default | Description                                              |
| -------------------- | --------- | ------- | -------------------------------------------------------- |
| `debugBundleEnabled` | `boolean` | `false` | Enables `GET /api/v1/debug/bundle` diagnostics endpoint. |
