# Local discovery with Bonjour

SignalHaven provides an optional DNS-SD sidecar image for automatic discovery
on trusted home networks. The sidecar advertises the host-published HTTP
endpoint as `_signalhaven._tcp.local.`; it does not proxy application traffic.

## Requirements and support

The container integration supports Docker Engine on Linux. It requires host
networking because mDNS uses link-local multicast and must publish addresses
from the physical host rather than a private Compose bridge.

Before enabling it, confirm that:

- UDP port 5353 is permitted by the host firewall.
- The server and client are on the same multicast-capable LAN or VLAN.
- Wireless client isolation is disabled between the iOS device and server.
- No network policy blocks multicast address `224.0.0.251` or `ff02::fb`.

Docker Desktop uses a virtualized network and is not supported for the sidecar.
For macOS development, use the host-native command in
[Host-native development](#host-native-development).

## Enable the sidecar

Copy `.env.example` to `.env`, configure the main SignalHaven stack, and start
the optional profile:

```bash
docker compose --profile bonjour up -d
```

The sidecar waits for `http://127.0.0.1:$SIGNALHAVEN_HTTP_PORT/api/v1/health`
to return HTTP 200 before advertising. It withdraws the advertisement when the
health check fails, restores it after recovery, and sends a DNS-SD goodbye on
graceful shutdown.

The generated server UUID is stored in the `signalhaven-bonjour` volume. Keep
that volume when updating or recreating the stack so clients continue to
recognize the same server.

## Configuration

| Variable                           | Default                                     | Purpose                                                                  |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| `SIGNALHAVEN_BONJOUR_IMAGE`        | `ghcr.io/rrainn/signalhaven-bonjour:latest` | Separately published advertiser image.                                   |
| `SIGNALHAVEN_HTTP_PORT`            | `3000`                                      | Host port placed in the DNS-SD SRV record and used for health checks.    |
| `SIGNALHAVEN_SERVICE_NAME`         | `SignalHaven`                               | Human-readable service instance name.                                    |
| `SIGNALHAVEN_SERVER_ID`            | Generated and persisted                     | Optional UUID override for deployments with externally managed identity. |
| `SIGNALHAVEN_BONJOUR_INTERFACES`   | All eligible interfaces                     | Optional comma-separated interface names or IP addresses.                |
| `SIGNALHAVEN_BONJOUR_DISABLE_IPV6` | `false`                                     | Disables AAAA advertisements when set to `true`.                         |
| `SIGNALHAVEN_HEALTH_URL`           | `http://127.0.0.1:PORT/api/v1/health`       | Direct sidecar-only override for custom deployments.                     |
| `SIGNALHAVEN_HEALTH_INTERVAL_MS`   | `5000`                                      | Delay between health probes.                                             |
| `SIGNALHAVEN_HEALTH_TIMEOUT_MS`    | `3000`                                      | Maximum duration of each health probe.                                   |
| `SIGNALHAVEN_BONJOUR_STATE_DIR`    | `/var/lib/signalhaven-bonjour`              | Directory containing the persisted server ID.                            |

The Compose file exposes the commonly needed settings. Advanced settings can
be added to a local Compose override without modifying the published file.

## Discovery contract

The sidecar publishes `_signalhaven._tcp` with these TXT fields:

| Field         | Meaning                                    |
| ------------- | ------------------------------------------ |
| `txtvers=1`   | Version of the TXT record schema.          |
| `protovers=1` | Version of the SignalHaven discovery API.  |
| `path=/`      | Base HTTP path on the advertised endpoint. |
| `id=<uuid>`   | Stable, non-secret server identity.        |

Clients must treat Bonjour records as untrusted network input. After resolving
a service, verify the HTTP response from `/api/v1/health` before presenting it
as a usable SignalHaven server. Bonjour provides discovery, not authentication
or transport security.

An iOS target that browses this service should include:

```xml
<!-- Explain why the app scans the user's local network. -->
<key>NSLocalNetworkUsageDescription</key>
<string>SignalHaven discovers your television server on the local network.</string>

<!-- Declare the only Bonjour service type used by the app. -->
<key>NSBonjourServices</key>
<array>
	<string>_signalhaven._tcp</string>
</array>

<!-- Permit HTTP connections to local host names and addresses. -->
<key>NSAppTransportSecurity</key>
<dict>
	<key>NSAllowsLocalNetworking</key>
	<true/>
</dict>
```

Use Network framework discovery (`NWBrowser` or the current `NetworkBrowser`
API for the deployment target) and browse the default domain rather than
hard-coding `local.`.

## Diagnostics

Follow the sidecar's structured logs:

```bash
docker compose --profile bonjour logs -f signalhaven-bonjour
```

On Linux with Avahi tools installed, browse the service with:

```bash
avahi-browse --resolve --terminate _signalhaven._tcp
```

On macOS, browse with:

```bash
dns-sd -B _signalhaven._tcp
```

If the sidecar repeatedly reports health failures, verify that the configured
host port is reachable at `http://127.0.0.1:$SIGNALHAVEN_HTTP_PORT` on the
Docker host. If it advertises but clients cannot discover it, check firewall,
VLAN, and wireless multicast settings before changing the container network.

## Host-native development

Docker Desktop is unnecessary for local advertisement testing. With the main
stack already publishing port 3000, run this foreground command on macOS:

```bash
# This development advertisement ends when the command is stopped.
dns-sd -R "SignalHaven Development" _signalhaven._tcp local. 3000 \
  txtvers=1 protovers=1 path=/
```

This command intentionally omits a persisted ID. Use the Linux sidecar or a
host launch agent when testing identity-sensitive behavior across restarts.
