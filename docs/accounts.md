# Local accounts

SignalHaven requires a local username and password before the guide or recording
library can be opened. A new installation creates its first administrator during
setup. An upgraded configured installation prompts for that administrator on the
next visit; the first administrator atomically adopts the existing recordings,
series rules, and personal guide/player preferences.

Administrators manage tuners, channel topology, global settings, and additional
users. Standard users have private recording libraries and series rules, and can
customize their own guide, channel ordering, and player preferences. Accounts use
usernames and passwords only; SignalHaven does not collect an email address.
Administrative access does not grant library impersonation: recording FFmpeg and
Comskip work shown in Advanced is limited to the administrator's own recordings,
and its process controls return not found for another account's work.

The account API exposes `GET /api/v1/auth/status`, `POST /api/v1/auth/setup`,
`POST /api/v1/auth/login`, `GET /api/v1/auth/me`, and `POST /api/v1/auth/logout`.
Administrators use `GET/POST /api/v1/users`; every account uses
`GET/PATCH /api/v1/preferences` for its own UI, channel, and player settings.
Global `/api/v1/settings` remains administrator-only. Protected routes return 401
without a valid session and 403 when the authenticated role lacks permission.

Web clients use a 30-day, database-backed, HttpOnly session cookie. Native Apple
clients request an opaque bearer session and exchange it for scoped playback
capabilities so HLS subrequests do not expose the account session. Signing out or
revoking the session invalidates those capabilities.

Setup and login accept `{ username, password, transport }`, where `transport` is
`cookie` for the web app or `bearer` for native clients. Their response contains
`user`, `token` (null for cookie sessions), and `expiresAt`. Status returns
`requiresInitialAdmin`, `systemSetupRequired`, and the current `user` or null.

Authentication, password hashing, and playback capability creation have bounded
concurrency and per-account limits. One-off recordings may span at most 24 hours;
an account may keep up to 256 pending or active recordings and 128 series rules.
Automatic retention and quota cleanup are serialized. The recording quota is a
global completed-media ceiling, while automatic eviction considers only the
account whose new recording or playback cache crossed that ceiling. This keeps one
account from deleting another account's private library. If protected or existing
media leaves the volume above quota without an eligible recording from the
triggering account, SignalHaven logs a warning for the administrator. Host-level
disk monitoring remains recommended. Playback and image-proxy work are also
bounded to protect a long-running DVR from accidental or hostile exhaustion.

Media playback capabilities are scoped to the requesting session, account,
resource, and immutable playback choices. Issuance rotates the oldest capability
inside the same database lock instead of allowing an account to grow the ticket
table or become permanently locked out. Live capabilities are issued only for a
visible, enabled channel that currently has a streamable source.

The media-ticket response contains only a same-origin relative `playbackPath` and
`expiresAt`; raw capability values are neither modeled by clients nor written to
request logs. Playlist rewriting propagates the capability to nested playlists and
segments. Ticketed manifests, segments, channel artwork, tuner artwork, recording
artwork, and every authenticated API response use private/no-store caching.

Built-in accounts protect one SignalHaven installation from other local users,
but they are not a complete internet perimeter. Internet-exposed installations
still need current software, TLS, host firewalling, and a deliberately configured
reverse proxy. Protected API and media responses are private and non-cacheable so
browser caches cannot cross account switches.
