#!/bin/sh
# Entrypoint script for the SignalHaven container.
#
# Runs two Node.js processes in a single container:
#   - The Express backend API on port 3001 (internal only)
#   - The Next.js frontend server on port 3000 (user-facing)
#
# The Next.js rewrite rule in next.config.ts forwards all `/api/*` traffic
# to the backend via SIGNALHAVEN_BACKEND_ORIGIN.
#
# tini (PID 1) manages signal forwarding and zombie reaping for both children.
set -eu

signalhaven_uid=10001
signalhaven_gid=10001

# Keep device-owner groups while preventing the application from retaining
# the entrypoint's root group. Docker exposes device nodes without necessarily
# adding their owning groups to root's supplementary-group list.
signalhaven_groups=""
append_signalhaven_group() {
	group_id="$1"
	if [ "$group_id" = "0" ] || [ "$group_id" = "$signalhaven_gid" ]; then
		return
	fi
	case ",$signalhaven_groups," in
		*",$group_id,"*) return ;;
	esac
	if [ -z "$signalhaven_groups" ]; then
		signalhaven_groups="$group_id"
	else
		signalhaven_groups="$signalhaven_groups,$group_id"
	fi
}

if [ "$(id -u)" -eq 0 ]; then
	for group_id in $(id -G); do
		append_signalhaven_group "$group_id"
	done
	# NVIDIA and VAAPI devices may be 0660, so preserve their numeric groups
	# even when the minimal image has no matching /etc/group entry.
	for device_path in /dev/dri/renderD* /dev/nvidia* /dev/nvidia-caps/*; do
		if [ ! -e "$device_path" ]; then
			continue
		fi
		append_signalhaven_group "$(stat -c '%g' "$device_path")"
	done
fi

# Drop privileges once per process while supporting explicit non-root runtimes.
run_as_signalhaven() {
	if [ "$(id -u)" -ne 0 ]; then
		exec "$@"
	fi
	if [ -n "$signalhaven_groups" ]; then
		exec setpriv \
			--reuid="$signalhaven_uid" \
			--regid="$signalhaven_gid" \
			--groups="$signalhaven_groups" \
			--no-new-privs \
			-- "$@"
	fi
	exec setpriv \
		--reuid="$signalhaven_uid" \
		--regid="$signalhaven_gid" \
		--clear-groups \
		--no-new-privs \
		-- "$@"
}

# Health checks need privilege dropping but should not mutate storage.
if [ "${1:-}" = "--healthcheck" ]; then
	shift
	run_as_signalhaven "$@"
fi

# Bind mounts are commonly created as root:root after the image is built.
# Initialize only the mount root, avoiding an expensive recursive ownership
# walk over an existing recordings library.
recordings_dir="${SIGNALHAVEN_RECORDINGS_DIR:-/var/lib/signalhaven/recordings}"
if [ "$(id -u)" -eq 0 ]; then
	if ! mkdir -p "$recordings_dir" ||
		! chown signalhaven:signalhaven "$recordings_dir" ||
		! chmod u+rwx "$recordings_dir" ||
		! setpriv \
			--reuid="$signalhaven_uid" \
			--regid="$signalhaven_gid" \
			--clear-groups \
			-- test -w "$recordings_dir"; then
		echo "[signalhaven] warning: recording storage is not writable: $recordings_dir" >&2
	fi
elif ! mkdir -p "$recordings_dir" || ! test -w "$recordings_dir"; then
	echo "[signalhaven] warning: recording storage is not writable: $recordings_dir" >&2
fi

# Preserve normal container command overrides without letting them run as root.
if [ "$#" -gt 0 ]; then
	run_as_signalhaven "$@"
fi

# Start the Express backend on the internal port. DATABASE_URL and other
# runtime secrets are passed in as container environment variables.
run_as_signalhaven env PORT=3001 node /app/apps/backend/dist/src/index.js &

# Hand off to the Next.js standalone server, which becomes PID 2 and inherits
# tini's signal handling via `exec`. Any env vars set on the container are
# forwarded automatically. The /api/* rewrite destination was baked into the
# routes manifest at build time (see Dockerfile), so no extra env vars are
# needed here for proxying.
# With outputFileTracingRoot set to the monorepo root, Next.js mirrors the
# workspace directory structure inside the standalone bundle, so the entry
# point lives at apps/frontend/server.js within that bundle.
run_as_signalhaven env \
	HOSTNAME=0.0.0.0 \
	PORT=3000 \
	node /app/frontend-standalone/apps/frontend/server.js
