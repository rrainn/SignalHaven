import {
	recordingByProgramCreateSchema,
	recordingByProgramResponseSchema,
	recordingCreateSchema,
	recordingDeleteQuerySchema,
	recordingDetailSchema,
	commercialAnalysisSchema,
	recordingIdParamSchema,
	recordingLibraryScanResultSchema,
	recordingListQuerySchema,
	recordingListSchema,
	recordingPatchSchema,
	recordingSchema,
	RECORDING_CHANNEL_UNMAPPED_ERROR_CODE,
	RECORDING_PROGRAM_NOT_RECORDABLE_ERROR_CODE,
	TUNER_UNAVAILABLE_ERROR_CODE,
	type RecordingListQuery,
	type RecordingPatch
} from "@signalhaven/shared";
import { Router } from "express";
import { z } from "zod";

import { TunerUnavailableError } from "../../tuners/tuner-allocator";
import { CommercialAnalysisNotAvailableError } from "../../commercials/commercial-analysis.service";
import { ChannelNotStreamableError } from "../../streaming/streaming.service";
import {
	ChannelNotMappedError,
	EpgProgramNotFoundError,
	InvalidRecordingCursorError,
	ProgramNotRecordableError,
	RecordingNotFoundError,
	RecordingProtectedError,
	RecordingStorageNotConfiguredError,
	toPublicRecording,
	type RecordingsService
} from "../../recordings/recordings.service";
import {
	RecordingPlaybackNotFoundError,
	RecordingPlaybackSegmentNotFoundError,
	RecordingPlaybackSessionExpiredError,
	RecordingPlaybackUnavailableError
} from "../../recordings/recording-playback.service";
import { MAX_RECORDING_SEGMENT_NAME_LENGTH } from "../../recordings/recording-playback-session";
import { HttpError } from "../middleware/errors";
import { validate } from "../middleware/validate";

const recordingPlaybackSegmentParamSchema = z.object({
	id: z.string().uuid(),
	segment: z
		.string()
		.min(1)
		.max(MAX_RECORDING_SEGMENT_NAME_LENGTH)
		.regex(/^[A-Za-z0-9_-]+\.ts$/, "Invalid recording segment name")
});

const recordingPlaybackSessionQuerySchema = z.object({
	session: z.string().uuid()
});

const recordingPlaybackManifestQuerySchema = z.object({
	start: z.coerce.number().int().min(0).optional().default(0)
});

export function createRecordingsRouter(service: RecordingsService): Router {
	const router = Router();

	router.get(
		"/recordings",
		validate({ query: recordingListQuerySchema }),
		async (req, res, next) => {
			try {
				const query = req.query as unknown as RecordingListQuery;
				const page = await service.listPage(query);
				res.json(
					recordingListSchema.parse({
						items: page.items.map((recording) => ({
							...toPublicRecording(recording),
							metadata: recording.metadata
						})),
						total: page.total,
						totalSize: page.totalSize,
						limit: page.limit,
						offset: page.offset,
						nextCursor: page.nextCursor,
						seriesGroups: page.seriesGroups,
						oneOffGroup: page.oneOffGroup
					})
				);
			} catch (error) {
				next(translate(error));
			}
		}
	);

	router.post(
		"/recordings",
		validate({ body: recordingCreateSchema }),
		async (req, res, next) => {
			try {
				const body = req.body as {
					channelId: string;
					title: string;
					start: string;
					end: string;
					programId?: string;
				};
				const created = await service.schedule({
					channelId: body.channelId,
					title: body.title,
					start: new Date(body.start),
					end: new Date(body.end),
					...(body.programId !== undefined ? { programId: body.programId } : {})
				});
				res.status(201).json(recordingSchema.parse(toPublicRecording(created)));
			} catch (error) {
				next(translate(error));
			}
		}
	);

	router.post(
		"/recordings/by-program",
		validate({ body: recordingByProgramCreateSchema }),
		async (req, res, next) => {
			try {
				const body = req.body as { programId: string; channelId?: string };
				const result = await service.scheduleByProgram({
					programId: body.programId,
					...(body.channelId ? { channelId: body.channelId } : {})
				});
				res.status(result.created ? 201 : 200).json(
					recordingByProgramResponseSchema.parse({
						recording: toPublicRecording(result.recording),
						created: result.created
					})
				);
			} catch (error) {
				next(translate(error));
			}
		}
	);

	router.post("/recordings/library/scan", async (_req, res, next) => {
		try {
			const result = await service.scanLibrary();
			res.json(recordingLibraryScanResultSchema.parse(result));
		} catch (error) {
			next(translate(error));
		}
	});

	/** Keep provider artwork URLs and fetches behind the backend boundary. */
	router.get(
		"/recordings/:id/artwork",
		validate({ params: recordingIdParamSchema }),
		async (req, res, next) => {
			try {
				const artwork = await service.getArtwork(req.params["id"] as string);
				if (!artwork) {
					throw new HttpError(404, "not_found", "Artwork not available");
				}
				res.setHeader("Content-Type", artwork.contentType);
				res.setHeader(
					"Cache-Control",
					`public, max-age=${artwork.cacheMaxAgeSeconds}`
				);
				res.setHeader("X-Content-Type-Options", "nosniff");
				res.status(200).send(artwork.body);
			} catch (error) {
				next(translate(error));
			}
		}
	);

	router.get(
		"/recordings/:id/stream.m3u8",
		validate({
			params: recordingIdParamSchema,
			query: recordingPlaybackManifestQuerySchema
		}),
		async (req, res, next) => {
			try {
				const body = await service.getPlaybackManifest(
					req.params["id"] as string,
					{ requestId: req.id },
					req.query["start"] as unknown as number
				);
				applyPlaybackHeaders(res);
				res.setHeader(
					"Content-Type",
					"application/vnd.apple.mpegurl; charset=utf-8"
				);
				res.setHeader("Cache-Control", "no-store");
				res.status(200).send(body);
			} catch (error) {
				next(translate(error));
			}
		}
	);

	router.get(
		"/recordings/:id/segments/:segment",
		validate({
			params: recordingPlaybackSegmentParamSchema,
			query: recordingPlaybackSessionQuerySchema
		}),
		async (req, res, next) => {
			try {
				const body = await service.getPlaybackSegment(
					req.params["id"] as string,
					req.query["session"] as string,
					req.params["segment"] as string
				);
				applyPlaybackHeaders(res);
				res.setHeader("Content-Type", "video/mp2t");
				res.setHeader("Cache-Control", "private, max-age=300, immutable");
				res.status(200).send(body);
			} catch (error) {
				next(translate(error));
			}
		}
	);

	router.get(
		"/recordings/:id",
		validate({ params: recordingIdParamSchema }),
		async (req, res, next) => {
			try {
				const { record, metadata, commercialAnalysis } =
					await service.getDetailById(req.params["id"] as string);
				res.json(
					recordingDetailSchema.parse({
						...toPublicRecording(record),
						metadata,
						commercialAnalysis
					})
				);
			} catch (error) {
				next(translate(error));
			}
		}
	);

	router.patch(
		"/recordings/:id",
		validate({ params: recordingIdParamSchema, body: recordingPatchSchema }),
		async (req, res, next) => {
			try {
				const patch = req.body as RecordingPatch;
				const updated = await service.patch(req.params["id"] as string, {
					...(patch.watched !== undefined ? { watched: patch.watched } : {}),
					...(patch.watchedAt !== undefined
						? { watchedAt: patch.watchedAt }
						: {}),
					...(patch.resumePositionSeconds !== undefined
						? { resumePositionSeconds: patch.resumePositionSeconds }
						: {}),
					...(patch.manuallyProtected !== undefined
						? { manuallyProtected: patch.manuallyProtected }
						: {})
				});
				res.json(recordingSchema.parse(toPublicRecording(updated)));
			} catch (error) {
				next(translate(error));
			}
		}
	);

	router.post(
		"/recordings/:id/commercial-analysis/retry",
		validate({ params: recordingIdParamSchema }),
		async (req, res, next) => {
			try {
				const analysis = await service.retryCommercialAnalysis(
					req.params["id"] as string
				);
				res.json(commercialAnalysisSchema.parse(analysis));
			} catch (error) {
				next(translate(error));
			}
		}
	);

	router.post(
		"/recordings/:id/cancel",
		validate({ params: recordingIdParamSchema }),
		async (req, res, next) => {
			try {
				const updated = await service.cancel(req.params["id"] as string);
				res.json(recordingSchema.parse(toPublicRecording(updated)));
			} catch (error) {
				next(translate(error));
			}
		}
	);

	router.delete(
		"/recordings/:id",
		validate({
			params: recordingIdParamSchema,
			query: recordingDeleteQuerySchema
		}),
		async (req, res, next) => {
			try {
				const query = req.query as unknown as {
					keepFile: boolean;
					overrideProtection: boolean;
				};
				await service.delete(req.params["id"] as string, {
					keepFile: query.keepFile,
					overrideProtection: query.overrideProtection
				});
				res.status(204).end();
			} catch (error) {
				next(translate(error));
			}
		}
	);

	return router;
}

function translate(error: unknown): unknown {
	if (error instanceof CommercialAnalysisNotAvailableError) {
		return new HttpError(409, "commercial_analysis_unavailable", error.message);
	}
	if (
		error instanceof RecordingPlaybackNotFoundError ||
		error instanceof RecordingNotFoundError
	) {
		return new HttpError(404, "not_found", error.message);
	}
	if (
		error instanceof RecordingPlaybackUnavailableError ||
		error instanceof RecordingPlaybackSessionExpiredError ||
		error instanceof RecordingPlaybackSegmentNotFoundError
	) {
		return new HttpError(
			error.statusCode,
			error.code,
			error.message,
			error instanceof RecordingPlaybackUnavailableError
				? error.details
				: undefined,
			error instanceof RecordingPlaybackUnavailableError
				? error.diagnosticLogged
				: false
		);
	}
	if (error instanceof EpgProgramNotFoundError) {
		return new HttpError(404, "not_found", error.message);
	}
	if (error instanceof ChannelNotMappedError) {
		return new HttpError(
			409,
			RECORDING_CHANNEL_UNMAPPED_ERROR_CODE,
			error.message,
			{ epgChannelId: error.epgChannelId }
		);
	}
	if (error instanceof ProgramNotRecordableError) {
		return new HttpError(
			409,
			RECORDING_PROGRAM_NOT_RECORDABLE_ERROR_CODE,
			error.message
		);
	}
	if (error instanceof RecordingStorageNotConfiguredError) {
		return new HttpError(409, "storage_not_configured", error.message);
	}
	if (error instanceof RecordingProtectedError) {
		return new HttpError(409, "recording_protected", error.message, {
			recordingId: error.recordingId
		});
	}
	if (error instanceof InvalidRecordingCursorError) {
		return new HttpError(400, "invalid_cursor", error.message);
	}
	if (error instanceof TunerUnavailableError) {
		return new HttpError(409, TUNER_UNAVAILABLE_ERROR_CODE, error.message, {
			conflicts: error.conflicts
		});
	}
	if (error instanceof ChannelNotStreamableError) {
		return new HttpError(404, "not_found", error.message);
	}
	return error;
}

/** Recording HLS is consumable by same-origin and cross-origin web players. */
function applyPlaybackHeaders(res: import("express").Response): void {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
	res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}
