# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

SignalHaven is primarily for technically comfortable homelab users who want to run their own live-TV system. Jellyfin users are an especially relevant audience: they may already self-host their media library but want a product centered more deeply on live television and DVR workflows.

## Product Purpose

SignalHaven is a self-hosted live-TV and DVR stack. It discovers or accepts TV sources, builds a unified channel guide, streams live channels to the browser, supports time-shifted viewing, schedules recordings, and manages recordings stored on the user's own infrastructure.

Success means a homelab user can operate a capable live-TV system without depending on a proprietary or cloud-hosted service for its core functionality.

## Positioning

SignalHaven is an open live-TV system built for self-hosters. Unlike closed products such as Channels DVR and Plex, its core is intended to remain free and open source. Unlike Jellyfin, whose broader media-library experience centers heavily on existing content, SignalHaven makes live television, its guide, playback, and DVR lifecycle the primary product.

Openness is also a product commitment: the system should remain approachable through its APIs and amenable to customization rather than operating as a closed appliance.

## Operating Context

Users deploy SignalHaven in a homelab, commonly with Docker Compose and PostgreSQL, and access its responsive web interface from a browser. Their television sources may include HDHomeRun network tuners, IPTV/M3U playlists, and direct HLS streams. Guide data may come from automatically managed HDHomeRun data or XMLTV sources. Recordings and time-shift media remain on storage controlled by the user.

The primary workflow moves through tuner setup, guide-data configuration, channel mapping and preferences, guide browsing or search, live playback, recording scheduling, and management or playback of the resulting recording library.

## Capabilities and Constraints

- SignalHaven must not require a cloud service to provide its core product experience.
- Privacy and user control over infrastructure and media are durable requirements.
- Performance and polish are first-class product requirements. Core flows should feel fast and responsive on realistic homelab hardware, and shipped experiences should include thoughtful loading, empty, error, recovery, responsive, and accessibility behavior rather than treating them as follow-up work.
- Video playback is SignalHaven's most critical product path and the primary reason users choose the application. Playback startup, continuity, controls, error recovery, and media quality take priority over secondary interface features and ornamental polish.
- The product supports HDHomeRun, IPTV/M3U, and direct HLS sources.
- The browser experience includes a unified guide, channel management, global search, live playback with a configurable rolling buffer, one-off and series recording, scheduling, recording retention, and local recording playback.
- Transcoding supports profile-based output and hardware-acceleration preferences, with software fallback where available.
- The system exposes an API and should preserve room for user customization and third-party integration.
- SignalHaven's core must remain free, open source, and usable without a cloud dependency. The repository does not yet contain a license file, so the specific license remains an open decision and must not be implied before it is chosen.
- A future cloud subscription may add functionality, but its features, pricing, and boundary with the open core remain open decisions. It must not make the core product cloud-dependent.

## Brand Commitments

The product name is **SignalHaven**. Its voice should make advanced media infrastructure feel calm, approachable, dependable, and honest about technical requirements. Existing production logos and the inherited root `DESIGN.md` are binding brand assets and guidance.

## Evidence on Hand

- `../../README.md` documents the self-hosted live-TV and DVR proposition, supported tuner types, Docker Compose quickstart, recording storage, transcoding, and live-TV buffering.
- `../../docs/architecture.md` documents the Next.js frontend, Express API, PostgreSQL persistence, tuner orchestration, streaming, recording lifecycle, and WebSocket updates.
- `../../docs/configuration.md` documents the current configuration surface and operational constraints.
- `app/` contains implemented guide, channel, watch, scheduler, recording, settings, onboarding, search, and advanced-diagnostics experiences.
- `public/icons/` and `app/_layout/BrandMark.tsx` contain the production brand assets.
- No testimonials, customer logos, usage benchmarks, press coverage, subscription details, pricing claims, or chosen open-source license are currently established; future work must not fabricate them.

## Product Principles

1. **Video is the product.** Treat fast, reliable live and recorded playback as SignalHaven's most critical path. Discovery, guide navigation, time shifting, and recording exist to help users reach and control the media without friction.
2. **The user owns the system.** Keep core operation local, private, and independent of mandatory cloud services.
3. **Open beyond the source code.** Preserve useful APIs and customization paths so SignalHaven can participate in a homelab rather than becoming a closed appliance.
4. **Speed and polish are features.** Keep routine interactions responsive, use homelab resources deliberately, and carry every workflow through its edge states with the same care as its happy path.
5. **Be precise about trust.** Clearly distinguish shipped capabilities from future intentions, especially around licensing, compatibility, security boundaries, and integrations.
