# HTTPS service discovery with Bonjour

SignalHaven provides an optional DNS-SD sidecar for discovery on trusted home
networks. Bonjour discovers a stable server identity and canonical URL; it does
not carry application traffic and its generated `.local` host name is never a
client API endpoint.

## Network contract

The sidecar publishes `_signalhaven._tcp.local.` on HTTPS port 443 with these
TXT fields:

| Field         | Meaning                                          |
| ------------- | ------------------------------------------------ |
| `txtvers=2`   | Version 2 of the DNS-SD TXT schema.              |
| `protovers=2` | Version 2 of the SignalHaven discovery contract. |
| `url=<https>` | Canonical, externally reachable HTTPS base URL.  |
| `id=<uuid>`   | Stable, non-secret server selection identity.    |

TXT and SRV records are untrusted network input. Clients must require both
version fields, parse `id` as a UUID, and strictly validate `url`. The URL must
be absolute HTTPS, have a host, and contain no credentials, query, or fragment.
Clients append API and media paths to this canonical URL rather than constructing
a URL from the Bonjour SRV host or port.

Before showing a server, clients request `<url>/api/v1/health` and require HTTP 200. The sidecar checks the same reverse-proxied endpoint before advertising and
withdraws the record after it becomes unhealthy.

## HTTPS deployment example

Copy `.env.example` to `.env` and configure at least:

```dotenv
# This host must resolve to the reverse proxy from every client LAN.
PUBLIC_URL=https://signalhaven.example.com

# Plaintext traffic is available only on the proxy host.
SIGNALHAVEN_HTTP_PORT=3000
```

Then start the application and optional Linux Bonjour sidecar:

```bash
docker compose --profile bonjour up -d
```

The Compose example binds the application and PostgreSQL ports to loopback.
Configure a reverse proxy on the same host to listen on TCP 443, terminate TLS
for the `PUBLIC_URL` host, and forward to `http://127.0.0.1:3000`. Do not change
the application mapping to a wildcard or LAN address.

The reverse proxy must:

- preserve `Host` or set the equivalent forwarded host;
- set the forwarded protocol to `https`;
- support HTTP/1.1 connection upgrades for WebSockets;
- stream response bodies without whole-response buffering; and
- preserve request cancellation and long-lived streaming connections.

The [nginx example](examples/signalhaven-nginx.conf) shows these settings while
exposing only HTTPS port 443. Replace its host and certificate paths before use.

When `PUBLIC_URL` contains a path such as
`https://signalhaven.example.com/tv`, route that prefix to SignalHaven without
dropping or duplicating it. The sidecar normalizes trailing slashes and checks
`https://signalhaven.example.com/tv/api/v1/health`.

Create a local DNS record for the canonical host that resolves to the reverse
proxy's LAN address. Verify the certificate chain and host name from an actual
client device; Bonjour cannot fix split-DNS or certificate problems.

## Sidecar configuration

| Variable                           | Default                                     | Purpose                                                                  |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| `PUBLIC_URL`                       | _required_                                  | Canonical HTTPS base URL placed in TXT and used for health checks.       |
| `SIGNALHAVEN_BONJOUR_IMAGE`        | `ghcr.io/rrainn/signalhaven-bonjour:latest` | Separately published advertiser image.                                   |
| `SIGNALHAVEN_SERVICE_NAME`         | `SignalHaven`                               | Human-readable service instance name.                                    |
| `SIGNALHAVEN_SERVER_ID`            | Generated and persisted                     | Optional UUID override for deployments with externally managed identity. |
| `SIGNALHAVEN_BONJOUR_INTERFACES`   | All eligible interfaces                     | Optional comma-separated interface names or IP addresses.                |
| `SIGNALHAVEN_BONJOUR_DISABLE_IPV6` | `false`                                     | Disables AAAA advertisements when set to `true`.                         |
| `SIGNALHAVEN_HEALTH_INTERVAL_MS`   | `5000`                                      | Delay between HTTPS health probes.                                       |
| `SIGNALHAVEN_HEALTH_TIMEOUT_MS`    | `3000`                                      | Maximum duration of each health probe.                                   |
| `SIGNALHAVEN_BONJOUR_STATE_DIR`    | `/var/lib/signalhaven-bonjour`              | Directory containing the persisted server ID.                            |

`PUBLIC_URL` is validated before multicast sockets are opened. HTTP URLs,
credentials, nonstandard ports, malformed URLs, unsupported schemes, queries,
fragments, and TXT values too large for DNS-SD fail startup with an actionable
error.
`SIGNALHAVEN_HEALTH_URL` is no longer accepted because a direct backend probe
could advertise a reverse proxy that clients cannot actually reach.

The generated UUID is stored in the `signalhaven-bonjour` volume. Keep that
volume across updates so saved selections retain the same identity.

## Requirements and support

The container integration supports Docker Engine on Linux and requires host
networking so mDNS publishes addresses from the physical host. Before enabling
it, confirm that:

- UDP port 5353 is permitted by the host firewall;
- the server and client share a multicast-capable LAN or VLAN;
- wireless client isolation is disabled; and
- multicast `224.0.0.251` and `ff02::fb` are not blocked.

Docker Desktop uses a virtualized network and is not supported for the sidecar.
For macOS development, use the host-native command below.

## Diagnostics

Follow structured sidecar events:

```bash
docker compose --profile bonjour logs -f signalhaven-bonjour
```

Startup logs include the normalized `publicUrl` and advertised port. An
`advertised` event occurs only after the canonical HTTPS health request returns
200; `health-changed` followed by `withdrawn` confirms removal after a failure.

Inspect the DNS-SD record on Linux:

```bash
avahi-browse --resolve --terminate _signalhaven._tcp
```

Or on macOS:

```bash
dns-sd -B _signalhaven._tcp
dns-sd -L "SignalHaven" _signalhaven._tcp local.
```

If health checks fail, request `${PUBLIC_URL}/api/v1/health` from the sidecar
host and a client device. Check local DNS, the TLS chain, reverse-proxy routing,
and forwarded headers before investigating multicast.

## Host-native development

Use a test certificate trusted by the client device and a stable UUID:

```bash
# Replace both values; the advertisement ends when this command is stopped.
dns-sd -R "SignalHaven Development" _signalhaven._tcp local. 443 \
  txtvers=2 protovers=2 \
  id=f22b18a0-f7f1-40fd-9225-2da245803a47 \
  url=https://signalhaven.test
```

## Migration from version 1

Version-1 records exposed a plaintext SRV host, port, and `path`. Version-2
clients intentionally reject those records and show an update message; there is
no insecure fallback. Upgrade and configure the sidecar before rolling out a
version-2-only client, preserve its identity volume or `SIGNALHAVEN_SERVER_ID`,
and confirm HTTPS health before asking users to select the server again.

See [Bonjour discovery version 2 migration](migrations/bonjour-v2.md) for the
operator checklist and rollback considerations.
