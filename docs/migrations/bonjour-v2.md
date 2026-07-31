# Bonjour discovery version 2 migration

Bonjour discovery version 2 replaces direct plaintext `.local` connections
with a canonical HTTPS URL. Version-2 clients do not fall back to version-1
records because doing so would bypass the configured TLS endpoint.

## Before upgrading clients

1. Configure a reverse proxy and a certificate valid for the canonical host.
2. Add local DNS for that host and verify it from every client network.
3. Set `PUBLIC_URL` to the externally reachable HTTPS base URL.
4. Keep the existing `signalhaven-bonjour` volume or stable
   `SIGNALHAVEN_SERVER_ID` so the server UUID does not change.
5. Bind `SIGNALHAVEN_HTTP_PORT` only to loopback or an internal container
   network; expose only the reverse proxy to the LAN.
6. Upgrade the sidecar and confirm its TXT record contains `txtvers=2`,
   `protovers=2`, `url`, and the previous `id`.
7. Confirm the sidecar withdraws its record when the HTTPS health endpoint is
   unavailable, then restore the proxy and confirm it advertises again.

Saved version-1 client selections do not contain the canonical URL and must be
selected again after discovery. If rollback is necessary, roll back clients and
the sidecar together; a version-2 client will continue rejecting a version-1
record with a migration message.
