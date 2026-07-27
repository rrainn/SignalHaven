# FFmpeg distribution notice

SignalHaven's container includes unmodified FFmpeg and FFprobe executables from
BtbN's GPL build variant. These executables are separate programs distributed
alongside the MIT-licensed SignalHaven application and remain licensed under
GNU GPL version 3 or later. The complete license text is installed next to this
notice as `LICENSE.txt` in the container image.

## Pinned binary artifacts

- BtbN release: `autobuild-2026-06-30-13-34`
- BtbN build-recipe commit: `7a83528ea3431e9eca982a712bc3a7cd0789d5d0`
- FFmpeg source commit: `7d0e8420048cffd0ca3883b877ead2390496d0b2`
- amd64 archive SHA-256: `f0c580f5f12af54e8c9c649c70b2d25f264edb35393203d34b20cf4f9c126288`
- arm64 archive SHA-256: `8b61e22e674c9f3530a8953a684d6789dd94de26fffd614b9234b15673b85d04`

The Docker build verifies the architecture-specific archive before extracting
it. BtbN's immutable build-recipe commit records the source versions, download
locations, patches, and checksums for FFmpeg and its statically linked
dependencies:

- https://github.com/BtbN/FFmpeg-Builds/tree/7a83528ea3431e9eca982a712bc3a7cd0789d5d0
- https://github.com/FFmpeg/FFmpeg/tree/7d0e8420048cffd0ca3883b877ead2390496d0b2

When updating FFmpeg, update this notice and every `FFMPEG_BTBN_*` argument in
the Dockerfile in the same change. Release maintainers must retain access to
the corresponding source and build inputs for as long as the binary image is
distributed.
