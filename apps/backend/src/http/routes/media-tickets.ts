import {
	liveMediaTicketRequestSchema,
	mediaTicketSchema,
	recordingMediaTicketRequestSchema
} from "@signalhaven/shared";
import { Router } from "express";
import { z } from "zod";

import type { MediaTicketService } from "../../auth/media-ticket.service";
import {
	RecordingNotFoundError,
	type RecordingsService
} from "../../recordings/recordings.service";
import { ChannelNotStreamableError } from "../../streaming/streaming.service";
import { toApiDateTime } from "../date-time";
import { HttpError } from "../middleware/errors";
import { validate } from "../middleware/validate";

const liveParamsSchema = z.object({
	channelId: z.string().min(1).max(128)
});

const recordingParamsSchema = z.object({ id: z.string().uuid() });

export function createMediaTicketsRouter(options: {
	tickets: MediaTicketService;
	recordings?: Pick<RecordingsService, "assertOwned">;
	/** Validates a live source without starting a tuner lease or FFmpeg process. */
	assertLiveStreamable: (channelId: string) => Promise<void>;
}): Router {
	const router = Router();

	router.post(
		"/stream/:channelId/media-ticket",
		validate({ params: liveParamsSchema, body: liveMediaTicketRequestSchema }),
		async (req, res, next) => {
			try {
				const channelId = req.params["channelId"] as string;
				await options.assertLiveStreamable(channelId);
				const profile = req.body.profile ?? "auto";
				const issued = await options.tickets.issue(req.auth!, {
					kind: "live",
					id: channelId,
					claims: {
						profile,
						...(req.body.viewerId ? { viewerId: req.body.viewerId } : {})
					}
				});
				const query = new URLSearchParams({ mediaTicket: issued.token });
				query.set("profile", profile);
				if (req.body.viewerId) query.set("viewerId", req.body.viewerId);
				res.setHeader("Cache-Control", "private, no-store");
				res.status(201).json(
					mediaTicketSchema.parse({
						playbackPath: `/api/v1/stream/${encodeURIComponent(channelId)}/master.m3u8?${query.toString()}`,
						expiresAt: toApiDateTime(issued.expiresAt)
					})
				);
			} catch (error) {
				next(
					error instanceof ChannelNotStreamableError
						? new HttpError(404, "not_found", "Channel is unavailable")
						: error
				);
			}
		}
	);

	if (options.recordings) {
		router.post(
			"/recordings/:id/media-ticket",
			validate({
				params: recordingParamsSchema,
				body: recordingMediaTicketRequestSchema
			}),
			async (req, res, next) => {
				try {
					const recordingId = req.params["id"] as string;
					const start = req.body.start ?? 0;
					await options.recordings!.assertOwned(recordingId, req.auth!.user.id);
					const issued = await options.tickets.issue(req.auth!, {
						kind: "recording",
						id: recordingId,
						claims: {
							start,
							...(req.body.viewerId ? { viewerId: req.body.viewerId } : {})
						}
					});
					const query = new URLSearchParams({ mediaTicket: issued.token });
					if (req.body.viewerId) query.set("viewerId", req.body.viewerId);
					query.set("start", String(start));
					res.setHeader("Cache-Control", "private, no-store");
					res.status(201).json(
						mediaTicketSchema.parse({
							playbackPath: `/api/v1/recordings/${recordingId}/stream.m3u8?${query.toString()}`,
							expiresAt: toApiDateTime(issued.expiresAt)
						})
					);
				} catch (error) {
					next(
						error instanceof RecordingNotFoundError
							? new HttpError(404, "not_found", "Recording not found")
							: error
					);
				}
			}
		);
	}

	return router;
}
