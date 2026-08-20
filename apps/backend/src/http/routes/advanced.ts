import {
	comskipWorkListSchema,
	externalIpResponseSchema,
	ffmpegWorkListSchema
} from "@signalhaven/shared";
import { Router } from "express";
import { isIP } from "node:net";
import { z } from "zod";

import {
	RecordingNotFoundError,
	type RecordingsService
} from "../../recordings/recordings.service";
import type { StreamingService } from "../../streaming/streaming.service";
import type { CommercialAnalysisService } from "../../commercials/commercial-analysis.service";
import { HttpError } from "../middleware/errors";
import { validate } from "../middleware/validate";

const workParamSchema = z.object({ id: z.string().min(1).max(512) });
const externalIpUrl = "https://ip.rrainn.space";

/** Require an affirmative value before contacting the external IP service. */
function isExternalIpLookupEnabled(env: NodeJS.ProcessEnv): boolean {
	return ["1", "true", "yes", "on"].includes(
		env.SIGNALHAVEN_EXTERNAL_IP_LOOKUP_ENABLED?.toLowerCase() ?? ""
	);
}

/**
 * Extract an IP from both generations of the lookup service response.
 *
 * The service originally returned a bare address and now returns metadata as
 * JSON, so accepting both formats keeps older compatible deployments working.
 */
function parseExternalIp(body: string): string | null {
	const plainIp = body.trim();
	if (isIP(plainIp) !== 0) return plainIp;

	try {
		const payload: unknown = JSON.parse(body);
		if (
			typeof payload === "object" &&
			payload !== null &&
			"ip" in payload &&
			typeof payload.ip === "string"
		) {
			const jsonIp = payload.ip.trim();
			return isIP(jsonIp) !== 0 ? jsonIp : null;
		}
	} catch {
		// A non-JSON body is handled as an unavailable lookup below.
	}

	return null;
}

/**
 * Advanced controls are mounted behind the administrator middleware, while
 * recording diagnostics remain scoped to that administrator's private library.
 */
export function createAdvancedRouter(deps: {
	streaming?: StreamingService | undefined;
	recordings?: RecordingsService | undefined;
	commercialAnalysis?:
		| Pick<CommercialAnalysisService, "getActiveWork">
		| undefined;
	fetch?: typeof fetch | undefined;
	env?: NodeJS.ProcessEnv | undefined;
}): Router {
	const router = Router();
	const fetchExternalIp = deps.fetch ?? fetch;
	const externalIpLookupEnabled = isExternalIpLookupEnabled(
		deps.env ?? process.env
	);

	router.get("/advanced/external-ip", async (_req, res, next) => {
		if (!externalIpLookupEnabled) {
			next(
				new HttpError(
					403,
					"external_ip_lookup_disabled",
					"External IP lookup is disabled by the server administrator"
				)
			);
			return;
		}

		try {
			const response = await fetchExternalIp(externalIpUrl, {
				headers: { Accept: "text/plain" },
				signal: AbortSignal.timeout(5_000)
			});
			if (!response.ok) {
				throw new Error(
					`External IP lookup failed with HTTP ${response.status}`
				);
			}
			const ip = parseExternalIp(await response.text());
			if (ip === null) {
				throw new Error("External IP lookup returned an invalid address");
			}
			res.setHeader("Cache-Control", "no-store");
			res.json(externalIpResponseSchema.parse({ ip }));
		} catch {
			next(
				new HttpError(
					502,
					"external_ip_unavailable",
					"Could not determine the server external IP"
				)
			);
		}
	});

	router.get("/advanced/ffmpeg", async (req, res, next) => {
		try {
			const [live, recordings] = await Promise.all([
				Promise.resolve(deps.streaming?.getActiveSessions() ?? []),
				deps.recordings?.getActiveFfmpegWork(req.auth!.user.id) ??
					Promise.resolve([])
			]);
			const items = [
				...live.map((session) => ({
					id: `live:${session.id}`,
					kind: "live-stream" as const,
					label: `Live channel ${session.channelId}`,
					channelId: session.channelId,
					state: session.state,
					startedAt: session.startedAt,
					profile: session.profile,
					hwaccel: session.hwaccel,
					clientCount: session.clientCount
				})),
				...recordings.map((recording) => ({
					id: `${recording.kind === "recording" ? "recording" : "playback"}:${
						recording.kind === "recording"
							? recording.recordingId
							: recording.playbackSessionId
					}`,
					kind: recording.kind,
					label: recording.title,
					recordingId: recording.recordingId,
					state: recording.state,
					startedAt: recording.startedAt,
					...(recording.profile ? { profile: recording.profile } : {}),
					...(recording.hwaccel !== undefined
						? { hwaccel: recording.hwaccel }
						: {}),
					...(recording.clientCount !== undefined
						? { clientCount: recording.clientCount }
						: {})
				}))
			];
			res.setHeader("Cache-Control", "no-store");
			res.json(ffmpegWorkListSchema.parse({ items }));
		} catch (error) {
			next(error);
		}
	});

	router.get("/advanced/comskip", (req, res) => {
		const items = (
			deps.commercialAnalysis?.getActiveWork(req.auth!.user.id) ?? []
		).map((work) => ({
			id: `commercial:${work.recordingId}`,
			...work
		}));
		res.setHeader("Cache-Control", "no-store");
		res.json(comskipWorkListSchema.parse({ items }));
	});

	router.delete(
		"/advanced/ffmpeg/:id",
		validate({ params: workParamSchema }),
		async (req, res, next) => {
			try {
				const id = req.params["id"] as string;
				if (id.startsWith("live:")) {
					const stopped = deps.streaming?.stopSession(id.slice(5)) ?? false;
					if (!stopped)
						throw new HttpError(404, "not_found", "FFmpeg work not found");
				} else if (id.startsWith("recording:")) {
					if (!deps.recordings)
						throw new HttpError(404, "not_found", "FFmpeg work not found");
					await deps.recordings.cancelOwned(id.slice(10), req.auth!.user.id);
				} else if (id.startsWith("playback:")) {
					if (!deps.recordings)
						throw new HttpError(404, "not_found", "FFmpeg work not found");
					const stopped = await deps.recordings.stopOwnedPlayback(
						id.slice(9),
						req.auth!.user.id
					);
					if (!stopped)
						throw new HttpError(404, "not_found", "FFmpeg work not found");
				} else {
					throw new HttpError(404, "not_found", "FFmpeg work not found");
				}
				res.status(204).end();
			} catch (error) {
				next(
					error instanceof RecordingNotFoundError
						? new HttpError(404, "not_found", error.message)
						: error
				);
			}
		}
	);

	return router;
}
