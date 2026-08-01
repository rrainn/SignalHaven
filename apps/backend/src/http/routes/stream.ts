import { Router } from "express";
import { transcodeProfileSchema } from "@signalhaven/shared";
import { z } from "zod";

import {
	AdaptiveEncoderCapacityError,
	MAX_SEGMENT_NAME_LENGTH
} from "../../streaming/stream-session";
import type { PlaybackProfile } from "../../streaming/stream-session";
import {
	ChannelNotStreamableError,
	StreamStoppedByOperatorError,
	type StreamingService
} from "../../streaming/streaming.service";
import { TunerUnavailableError } from "../../tuners/tuner-allocator";
import { HttpError } from "../middleware/errors";
import { validate } from "../middleware/validate";

const channelIdParamSchema = z.object({
	channelId: z.string().min(1).max(128)
});

const profileQuerySchema = z.object({
	profile: z.union([z.literal("auto"), transcodeProfileSchema]).optional(),
	viewerId: z.string().uuid().optional()
});

const viewerReleaseParamSchema = z.object({
	channelId: z.string().min(1).max(128),
	viewerId: z.string().uuid()
});

const segmentParamSchema = z.object({
	channelId: z.string().min(1).max(128),
	segment: z
		.string()
		.min(1)
		.max(MAX_SEGMENT_NAME_LENGTH)
		.regex(/^[A-Za-z0-9._-]+$/, "Invalid segment name")
});

const renditionParamSchema = segmentParamSchema.extend({
	rendition: z.enum(["1080p", "720p", "480p"])
});

/**
 * Streaming proxy routes (rrainn/SignalHaven#15).
 *
 *   * `GET /stream/:channelId/master.m3u8`     — synthetic HLS master that
 *     points at our media playlist. Attaches a client to the per-channel
 *     `StreamSession`, spinning up ffmpeg + acquiring a tuner lease the
 *     first time. Subsequent fetches on the same channel reuse the lease.
 *   * `GET /stream/:channelId/playlist.m3u8`   — current media playlist.
 *   * `GET /stream/:channelId/segments/:segment` — segment bytes.
 *
 * Every response is CORS-friendly (`Access-Control-Allow-Origin: *`) so
 * web players can fetch playlists / segments from a different origin to
 * the API. Playlists are marked `no-cache` (they must always be re-read
 * for fresh segments); segments themselves are immutable once written.
 */
export function createStreamRouter(streaming: StreamingService): Router {
	const router = Router();

	router.get(
		"/stream/:channelId/master.m3u8",
		validate({ params: channelIdParamSchema, query: profileQuerySchema }),
		async (req, res, next) => {
			const channelId = req.params["channelId"] as string;
			const profile = req.query["profile"] as PlaybackProfile | undefined;
			const viewerId = req.query["viewerId"] as string | undefined;
			let attached = false;
			let session: Awaited<ReturnType<StreamingService["attach"]>> | undefined;
			try {
				session = await streaming.attach(channelId, profile ?? "auto");
				attached = true;
				registerDetach(req, res, session);
				if (viewerId) {
					session.attachViewer(viewerId);
				}

				const body = await session.readMasterPlaylist(viewerId);
				applyCommonHeaders(res);
				res.setHeader(
					"Content-Type",
					"application/vnd.apple.mpegurl; charset=utf-8"
				);
				res.setHeader("Cache-Control", "no-store");
				res.status(200).send(body);
			} catch (err) {
				if (attached) {
					// Should not happen — `attach()` either returns a usable session
					// or throws — but keep the refcount honest if it does.
					session?.detach();
				}
				next(translate(err));
			}
		}
	);

	router.get(
		"/stream/:channelId/playlist.m3u8",
		validate({ params: channelIdParamSchema, query: profileQuerySchema }),
		async (req, res, next) => {
			const channelId = req.params["channelId"] as string;
			const profile = req.query["profile"] as PlaybackProfile | undefined;
			const viewerId = req.query["viewerId"] as string | undefined;
			let attached = false;
			let session: Awaited<ReturnType<StreamingService["attach"]>> | undefined;
			try {
				session = await streaming.attach(channelId, profile ?? "auto");
				attached = true;
				registerDetach(req, res, session);
				if (viewerId) {
					session.attachViewer(viewerId);
				}
				const body = await session.readPlaylist();

				applyCommonHeaders(res);
				res.setHeader(
					"Content-Type",
					"application/vnd.apple.mpegurl; charset=utf-8"
				);
				res.setHeader("Cache-Control", "no-store");
				res.status(200).send(body);
			} catch (err) {
				if (attached) {
					session?.detach();
				}
				next(translate(err));
			}
		}
	);

	// sendBeacon uses POST so the browser can release a viewer during unload.
	router.post(
		"/stream/:channelId/viewers/:viewerId/release",
		validate({ params: viewerReleaseParamSchema, query: profileQuerySchema }),
		(req, res) => {
			const channelId = req.params["channelId"] as string;
			const viewerId = req.params["viewerId"] as string;
			const profile = req.query["profile"] as PlaybackProfile | undefined;
			streaming.releaseViewer(channelId, viewerId, profile);
			res.status(204).end();
		}
	);

	router.get(
		"/stream/:channelId/captions.m3u8",
		validate({ params: channelIdParamSchema, query: profileQuerySchema }),
		async (req, res, next) => {
			const channelId = req.params["channelId"] as string;
			const profile = req.query["profile"] as PlaybackProfile | undefined;
			const session = streaming.getSession(channelId, profile);
			if (!session || !session.captionsEnabled) {
				next(
					new HttpError(404, "not_found", `No captions track for ${channelId}`)
				);
				return;
			}
			try {
				const body = await session.readCaptionsPlaylist();
				applyCommonHeaders(res);
				res.setHeader(
					"Content-Type",
					"application/vnd.apple.mpegurl; charset=utf-8"
				);
				res.setHeader("Cache-Control", "no-store");
				res.status(200).send(body);
			} catch {
				// The captions sidecar is best-effort. Pending output is handled as
				// an empty live playlist; reserve this response for unexpected I/O.
				next(new HttpError(404, "not_found", `Captions playlist unavailable`));
			}
		}
	);

	router.get(
		"/stream/:channelId/segments/:segment",
		validate({ params: segmentParamSchema, query: profileQuerySchema }),
		async (req, res, next) => {
			const channelId = req.params["channelId"] as string;
			const segment = req.params["segment"] as string;
			const profile = req.query["profile"] as PlaybackProfile | undefined;
			const session = streaming.getSession(channelId, profile);
			if (!session) {
				next(
					new HttpError(404, "not_found", `No active stream for ${channelId}`)
				);
				return;
			}
			try {
				const body = await session.readSegment(segment);
				applyCommonHeaders(res);
				res.setHeader("Content-Type", contentTypeFor(segment));
				// Segments are immutable bytes once ffmpeg writes them: long cache
				// is safe and helps players that re-request after seeking.
				res.setHeader("Cache-Control", "public, max-age=300, immutable");
				res.status(200).send(body);
			} catch {
				next(new HttpError(404, "not_found", `Segment ${segment} not found`));
			}
		}
	);

	router.get(
		"/stream/:channelId/variants/:rendition/playlist.m3u8",
		validate({ params: renditionParamSchema, query: profileQuerySchema }),
		async (req, res, next) => {
			const channelId = req.params["channelId"] as string;
			const rendition = req.params["rendition"] as string;
			const session = streaming.getSession(channelId, "auto");
			if (!session) {
				next(
					new HttpError(404, "not_found", `No adaptive stream for ${channelId}`)
				);
				return;
			}
			try {
				const body = await session.readRenditionPlaylist(rendition);
				applyCommonHeaders(res);
				res.setHeader(
					"Content-Type",
					"application/vnd.apple.mpegurl; charset=utf-8"
				);
				res.setHeader("Cache-Control", "no-store");
				res.status(200).send(body);
			} catch {
				next(new HttpError(404, "not_found", "Adaptive rendition unavailable"));
			}
		}
	);

	router.get(
		"/stream/:channelId/variants/:rendition/segments/:segment",
		validate({ params: renditionParamSchema, query: profileQuerySchema }),
		async (req, res, next) => {
			const channelId = req.params["channelId"] as string;
			const rendition = req.params["rendition"] as string;
			const segment = req.params["segment"] as string;
			const session = streaming.getSession(channelId, "auto");
			if (!session) {
				next(
					new HttpError(404, "not_found", `No adaptive stream for ${channelId}`)
				);
				return;
			}
			try {
				const body = await session.readRenditionSegment(rendition, segment);
				applyCommonHeaders(res);
				res.setHeader("Content-Type", contentTypeFor(segment));
				res.setHeader("Cache-Control", "public, max-age=300, immutable");
				res.status(200).send(body);
			} catch {
				next(new HttpError(404, "not_found", `Segment ${segment} not found`));
			}
		}
	);

	// Lightweight introspection used by the UI / smoke tests to surface a
	// viewer-safe error and the active profile/hwaccel pair for the session.
	// Returns 404 when no session is active for the channel.
	router.get(
		"/stream/:channelId/status",
		validate({ params: channelIdParamSchema, query: profileQuerySchema }),
		(req, res, next) => {
			const channelId = req.params["channelId"] as string;
			const profile = req.query["profile"] as PlaybackProfile | undefined;
			const session = streaming.getSession(channelId, profile);
			if (!session) {
				next(
					new HttpError(404, "not_found", `No active stream for ${channelId}`)
				);
				return;
			}
			applyCommonHeaders(res);
			res.setHeader("Cache-Control", "no-store");
			res.status(200).json({
				channelId,
				profile: session.profile,
				playbackMode: session.profile === "auto" ? "adaptive" : "manual",
				availableProfiles: [
					"auto",
					"original-quality",
					"1080p",
					"720p",
					"480p",
					"audio-only",
					"direct"
				],
				activeRendition: session.profile === "auto" ? "auto" : session.profile,
				capacity: session.getCapacityStatus(),
				hwaccel: session.hwaccel,
				state: session.getState(),
				startedAt: session.startedAt.toISOString(),
				refCount: session.getRefCount(),
				timeShift: session.getTimeShiftStatus(),
				pipeline: session.getPipelineStatus(),
				lastError: session.getLastError() ?? null
			});
		}
	);

	return router;
}

function applyCommonHeaders(res: import("express").Response): void {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
	res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

function contentTypeFor(name: string): string {
	if (name.endsWith(".m4s")) return "video/iso.segment";
	if (name.endsWith(".mp4")) return "video/mp4";
	if (name.endsWith(".vtt")) return "text/vtt; charset=utf-8";
	return "video/mp2t";
}

/**
 * Bridge between the HTTP socket lifecycle and the session refcount: every
 * successful `attach()` must be paired with a `detach()` so the session can
 * tear down once the last client disconnects.
 */
function registerDetach(
	req: import("express").Request,
	res: import("express").Response,
	session: { detach: () => void }
): void {
	let detached = false;
	const once = (): void => {
		if (detached) return;
		detached = true;
		try {
			session.detach();
		} catch {
			// Detach errors must not bubble to the client.
		}
	};
	res.on("close", once);
	res.on("finish", once);
	// Belt-and-braces: `req.close` fires for aborted connections that never
	// reach the response object.
	req.on("close", once);
}

function translate(err: unknown): unknown {
	if (err instanceof HttpError) {
		return err;
	}
	if (err instanceof ChannelNotStreamableError) {
		return new HttpError(404, "not_found", err.message);
	}
	if (err instanceof StreamStoppedByOperatorError) {
		return new HttpError(409, "stream_stopped_by_operator", err.message);
	}
	if (err instanceof AdaptiveEncoderCapacityError) {
		return new HttpError(422, "encoder_capacity", err.message);
	}
	if (err instanceof TunerUnavailableError) {
		return new HttpError(409, err.code, err.message, {
			conflicts: err.conflicts
		});
	}
	return err;
}
