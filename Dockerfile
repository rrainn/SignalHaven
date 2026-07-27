# syntax=docker/dockerfile:1.7

# ----------------------------------------------------------------------------
# Development dependency stage: install the toolchain shared by all builds.
# ----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS development-dependencies

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /app

# Keep the native build toolchain in a discarded stage so runtime stays small.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first to maximise layer cache hits on source-only edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/frontend/package.json ./apps/frontend/package.json
COPY packages/shared/package.json ./packages/shared/package.json

# Corepack uses the packageManager field to activate the repository's pnpm version.
RUN corepack enable

# pnpm's content-addressed store lets independent installs reuse downloads
# without embedding the archive cache in exported layers or serializing work.
RUN --mount=type=cache,id=signalhaven-pnpm,target=/pnpm/store,sharing=shared \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir=/pnpm/store

# ----------------------------------------------------------------------------
# Shared build stage: both application workspaces consume these compiled types.
# ----------------------------------------------------------------------------
FROM development-dependencies AS shared-build

COPY packages/shared ./packages/shared

RUN pnpm --filter @signalhaven/shared build

# ----------------------------------------------------------------------------
# Backend build stage: changes here do not invalidate the frontend build.
# ----------------------------------------------------------------------------
FROM shared-build AS backend-build

COPY apps/backend ./apps/backend

RUN pnpm --filter @signalhaven/backend build

# ----------------------------------------------------------------------------
# Frontend build stage: produce the standalone Next.js server bundle.
# ----------------------------------------------------------------------------
FROM shared-build AS frontend-build

ENV NEXT_TELEMETRY_DISABLED=1

COPY apps/frontend ./apps/frontend

# SIGNALHAVEN_BACKEND_ORIGIN must be set here because Next.js bakes the rewrites()
# destination URL into the routes manifest at build time (not at runtime), so
# the proxy target must match the Express backend's internal port (3001).
RUN SIGNALHAVEN_BACKEND_ORIGIN=http://127.0.0.1:3001 pnpm --filter @signalhaven/frontend build

# Stash the Next.js standalone output (and the static + public assets that
# must be co-located with it) at stable paths for the runtime stage.
RUN mv apps/frontend/.next/standalone /tmp/frontend-standalone \
    && mv apps/frontend/.next/static    /tmp/frontend-static \
    && mv apps/frontend/public          /tmp/frontend-public

# ----------------------------------------------------------------------------
# Production dependency stage: source edits must not invalidate backend deps.
# ----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS production-dependencies

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/frontend/package.json ./apps/frontend/package.json
COPY packages/shared/package.json ./packages/shared/package.json

# Install only the backend and its workspace dependencies so Next.js and React
# stay out of the dependency tree copied into the final image.
RUN corepack enable

RUN --mount=type=cache,id=signalhaven-pnpm-production,target=/pnpm/store,sharing=shared \
    pnpm install --prod --filter @signalhaven/backend... --frozen-lockfile --ignore-scripts --store-dir=/pnpm/store

# ----------------------------------------------------------------------------
# FFmpeg stage: pull a statically-linked FFmpeg from an immutable BtbN GPL
# release. The archive is verified before extraction so a replaced or partial
# download cannot enter a published SignalHaven image.
# ----------------------------------------------------------------------------
FROM debian:bookworm-slim AS ffmpeg

ARG TARGETARCH
# Monthly releases have longer upstream retention than daily auto-builds.
# Update the tag, asset revision, both hashes, and third-party notice together.
ARG FFMPEG_BTBN_TAG=autobuild-2026-06-30-13-34
ARG FFMPEG_BTBN_REVISION=n7.1.5-1-g7d0e842004
ARG FFMPEG_BTBN_AMD64_SHA256=f0c580f5f12af54e8c9c649c70b2d25f264edb35393203d34b20cf4f9c126288
ARG FFMPEG_BTBN_ARM64_SHA256=8b61e22e674c9f3530a8953a684d6789dd94de26fffd614b9234b15673b85d04

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
	case "${TARGETARCH:-amd64}" in \
		amd64) BTBN_ARCH=linux64; expected_sha="${FFMPEG_BTBN_AMD64_SHA256}" ;; \
		arm64) BTBN_ARCH=linuxarm64; expected_sha="${FFMPEG_BTBN_ARM64_SHA256}" ;; \
		*) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
	esac; \
	asset="ffmpeg-${FFMPEG_BTBN_REVISION}-${BTBN_ARCH}-gpl-7.1.tar.xz"; \
	url="https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_BTBN_TAG}/${asset}"; \
	curl -fL --retry 5 --retry-delay 5 -o /tmp/ffmpeg.tar.xz "$url"; \
	printf '%s  %s\n' "$expected_sha" /tmp/ffmpeg.tar.xz | sha256sum --check --strict; \
	mkdir -p /opt/ffmpeg; \
    tar -xJf /tmp/ffmpeg.tar.xz -C /opt/ffmpeg --strip-components=1; \
    rm -f /tmp/ffmpeg.tar.xz; \
    install -m 0755 /opt/ffmpeg/bin/ffmpeg  /usr/local/bin/ffmpeg; \
    install -m 0755 /opt/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe; \
    /usr/local/bin/ffmpeg -version

# ----------------------------------------------------------------------------
# Runtime stage: slim Node 22 image + FFmpeg + minimal VAAPI runtime libs.
# ----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    SIGNALHAVEN_RECORDINGS_DIR=/var/lib/signalhaven/recordings

# Runtime libraries dlopen'd by the static FFmpeg for VAAPI hardware
# acceleration, plus tini/setpriv for signal handling and privilege dropping.
# NVIDIA's container runtime injects the matching CUDA/NVENC driver libraries
# when a deployment grants the container GPU access.
# On amd64 we install
# the lightweight `i965-va-driver` for broad compatibility with older Intel
# iGPUs; users on more recent Intel iGPUs can bind-mount the matching driver
# from the host at runtime. The `i965-va-driver` package is x86-only and not
# available on arm64, so it is skipped there.
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libva2 \
        libva-drm2 \
        libva-x11-2 \
        tini \
        util-linux \
        ca-certificates \
    && if [ "$TARGETARCH" = "amd64" ]; then \
           apt-get install -y --no-install-recommends i965-va-driver; \
       fi \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ffmpeg /usr/local/bin/ffmpeg  /usr/local/bin/ffmpeg
COPY --from=ffmpeg /usr/local/bin/ffprobe /usr/local/bin/ffprobe
COPY --from=ffmpeg /opt/ffmpeg/LICENSE.txt /usr/share/doc/signalhaven/ffmpeg/LICENSE.txt
COPY docs/third-party/ffmpeg.md /usr/share/doc/signalhaven/ffmpeg/README.md
COPY LICENSE /usr/share/doc/signalhaven/LICENSE.txt

# Sanity-check: the binary runs and reports the expected codecs. The amd64
# image supports both VAAPI and NVIDIA hosts; BtbN's arm64 GPL builds disable
# some of these backends, so the hardware capability checks remain amd64-only.
RUN ffmpeg -version \
    && ffmpeg -hide_banner -encoders 2>/dev/null | grep -E '(libx264|libx265| aac )' >/dev/null \
    && if [ "$TARGETARCH" = "amd64" ]; then \
           ffmpeg -hide_banner -hwaccels 2>/dev/null | grep -q vaapi; \
           ffmpeg -hide_banner -hwaccels 2>/dev/null | grep -q cuda; \
           ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_nvenc; \
           ffmpeg -hide_banner -filters 2>/dev/null | grep -q scale_cuda; \
       fi

# Unprivileged user; owns the recordings volume mount point.
RUN groupadd --system --gid 10001 signalhaven \
    && useradd --system --uid 10001 --gid signalhaven \
        --home-dir /app --shell /usr/sbin/nologin signalhaven \
    && mkdir -p "${SIGNALHAVEN_RECORDINGS_DIR}" \
    && chown -R signalhaven:signalhaven "${SIGNALHAVEN_RECORDINGS_DIR}"

WORKDIR /app

# Backend runtime files
COPY --from=production-dependencies --chown=signalhaven:signalhaven /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=production-dependencies --chown=signalhaven:signalhaven /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=signalhaven:signalhaven /app/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=backend-build --chown=signalhaven:signalhaven /app/apps/backend/package.json ./apps/backend/package.json
COPY --from=backend-build --chown=signalhaven:signalhaven /app/apps/backend/dist ./apps/backend/dist
COPY --from=backend-build --chown=signalhaven:signalhaven /app/apps/backend/migrations ./apps/backend/migrations
COPY --from=shared-build --chown=signalhaven:signalhaven /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=shared-build --chown=signalhaven:signalhaven /app/packages/shared/dist ./packages/shared/dist

# Next.js standalone server (self-contained: includes its own node_modules).
# Static assets and public files must sit alongside the standalone bundle so
# the Next.js server can find them at the paths it expects.
# With outputFileTracingRoot pointing at the monorepo root, Next.js mirrors
# the workspace path inside the standalone bundle: the server entry point and
# its sibling .next/ directory live at apps/frontend/ within the bundle.
COPY --from=frontend-build --chown=signalhaven:signalhaven /tmp/frontend-standalone ./frontend-standalone
COPY --from=frontend-build --chown=signalhaven:signalhaven /tmp/frontend-static     ./frontend-standalone/apps/frontend/.next/static
COPY --from=frontend-build --chown=signalhaven:signalhaven /tmp/frontend-public     ./frontend-standalone/apps/frontend/public

# Startup script: launches the Express backend on :3001 then execs the
# Next.js server on :3000 (the user-facing port).
COPY --chown=signalhaven:signalhaven docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Release metadata is deliberately consumed only after application build layers.
# Changing a version or Git SHA therefore keeps dependency and compilation cache hits.
ARG SIGNALHAVEN_VERSION=0.0.0
ARG SIGNALHAVEN_GIT_SHA=unknown
ENV SIGNALHAVEN_VERSION=${SIGNALHAVEN_VERSION} \
    SIGNALHAVEN_GIT_SHA=${SIGNALHAVEN_GIT_SHA}

# The entrypoint starts as root only to initialize mounted storage, then uses
# setpriv to run every application process as the unprivileged SignalHaven user.
USER root

EXPOSE 3000

VOLUME ["/var/lib/signalhaven/recordings"]

# Health check hits the Express backend directly on its internal port (3001)
# so it passes as soon as the API + database are ready, independently of the
# Next.js frontend startup time.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD /app/docker-entrypoint.sh --healthcheck node -e "fetch('http://127.0.0.1:3001/api/v1/health').then(r => { if (r.status !== 200) process.exit(1); }).catch(() => process.exit(1))"

# tini reaps child processes (both Next.js and the Express backend) and
# forwards signals to their shared process group during shutdown.
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/app/docker-entrypoint.sh"]
