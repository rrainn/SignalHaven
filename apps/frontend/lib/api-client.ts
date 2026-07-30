import {
	channelListSchema,
	channelMergeSchema,
	channelQualitySchema,
	epgGridSchema,
	epgProgramDetailsSchema,
	epgRefreshResultSchema,
	epgSourceCreateSchema,
	epgSourceListSchema,
	epgSourcePatchSchema,
	epgSourceSchema,
	healthResponseSchema,
	ffmpegWorkListSchema,
	recordingByProgramCreateSchema,
	recordingByProgramResponseSchema,
	recordingConflictListSchema,
	recordingCreateSchema,
	recordingDetailSchema,
	commercialAnalysisSchema,
	recordingListSchema,
	recordingPatchSchema,
	recordingSchema,
	RECORDING_LIST_MAX_LIMIT,
	searchResponseSchema,
	seriesRuleCreateSchema,
	seriesRuleListSchema,
	seriesRulePatchSchema,
	seriesRuleSchema,
	settingsPatchSchema,
	settingsSchema,
	systemInfoSchema,
	systemStatusSchema,
	streamStatusSchema,
	tunerCreateSchema,
	tunerDiscoveryResponseSchema,
	tunerListSchema,
	tunerPatchSchema,
	tunerSchema,
	tunerStatusSchema,
	tunerSyncResponseSchema,
	type ChannelList,
	type ChannelMerge,
	type ChannelQuality,
	type EpgGrid,
	type EpgProgramDetails,
	type EpgRefreshResult,
	type EpgSource,
	type EpgSourceCreate,
	type EpgSourceList,
	type EpgSourcePatch,
	externalIpResponseSchema,
	type ExternalIpResponse,
	type HealthResponse,
	type FfmpegWorkList,
	type Recording,
	type RecordingByProgramCreate,
	type RecordingByProgramResponse,
	type RecordingConflictList,
	type RecordingCreate,
	type RecordingDetail,
	type CommercialAnalysis,
	type RecordingList,
	type RecordingListQuery,
	type RecordingPatch,
	type SearchResponse,
	type SeriesRule,
	type SeriesRuleCreate,
	type SeriesRuleList,
	type SeriesRulePatch,
	type Settings,
	type SettingsPatch,
	type SystemInfo,
	type SystemStatus,
	type StreamStatus,
	type Tuner,
	type TunerCreate,
	type TunerDiscoveryResponse,
	type TunerList,
	type TunerPatch,
	type TunerStatus,
	type TunerSyncResponse
} from "@signalhaven/shared";
import { z, type ZodType } from "zod";

/**
 * Typed `fetch` wrapper for the SignalHaven backend.
 *
 * Responses are validated against zod schemas exported from `@signalhaven/shared`
 * so the frontend gets compile-time *and* runtime safety. Errors from the
 * server are normalised into {@link ApiError} instances which carry the
 * status code and an optional structured body.
 */

/** Resolved at module load time so the value is stable across calls. */
export const API_BASE_URL: string =
	// Same-origin in production (the dev server proxies `/api/*` via
	// `next.config.ts`), but tests / SSR can override.
	process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

export class ApiError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(message: string, status: number, body: unknown) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

export type ApiRequestInit = Omit<RequestInit, "body"> & {
	/** JSON body — will be `JSON.stringify`-ed and sent with the right header. */
	json?: unknown;
};

function buildUrl(path: string): string {
	if (/^https?:\/\//i.test(path)) return path;
	if (!API_BASE_URL) return path;
	const base = API_BASE_URL.endsWith("/")
		? API_BASE_URL.slice(0, -1)
		: API_BASE_URL;
	return base + (path.startsWith("/") ? path : `/${path}`);
}

/**
 * Low-level request helper. Public callers should prefer the typed helpers
 * (e.g. {@link getHealth}) so each endpoint is locked to its zod schema.
 */
export async function apiRequest<T>(
	path: string,
	schema: ZodType<T>,
	init: ApiRequestInit = {}
): Promise<T> {
	const { json, headers, ...rest } = init;
	const finalHeaders = new Headers(headers);
	finalHeaders.set("Accept", "application/json");
	let body: BodyInit | null = null;
	if (json !== undefined) {
		finalHeaders.set("Content-Type", "application/json");
		body = JSON.stringify(json);
	}

	const res = await fetch(buildUrl(path), {
		...rest,
		headers: finalHeaders,
		body
	});

	let payload: unknown = undefined;
	// Some endpoints return 204; only parse if there's content.
	if (res.status !== 204) {
		const text = await res.text();
		if (text.length > 0) {
			try {
				payload = JSON.parse(text);
			} catch {
				// Non-JSON body — preserved as a string for diagnostics.
				payload = text;
			}
		}
	}

	if (!res.ok) {
		const generic = `Request failed: ${res.status} ${res.statusText}`;
		throw new ApiError(
			advancedModeEnabled()
				? detailedApiMessage(payload, generic, res.status)
				: generic,
			res.status,
			payload
		);
	}

	const parsed = schema.safeParse(payload);
	if (!parsed.success) {
		throw new ApiError("Response did not match expected schema", res.status, {
			issues: parsed.error.issues,
			payload
		});
	}
	return parsed.data;
}

/** Read the local-only switch without coupling the API layer to React. */
function advancedModeEnabled(): boolean {
	if (typeof window === "undefined") return false;
	try {
		return (
			window.localStorage.getItem("signalhaven.advanced-mode.v1") === "true"
		);
	} catch {
		return false;
	}
}

/** Attach safe server diagnostics that make support reports actionable. */
function detailedApiMessage(
	payload: unknown,
	fallback: string,
	status: number
): string {
	const envelope = payload as {
		error?: { code?: string; message?: string; requestId?: string };
	} | null;
	const error = envelope?.error;
	const message = error?.message ?? fallback;
	const details = [
		error?.code ? `code: ${error.code}` : null,
		error?.requestId ? `request: ${error.requestId}` : null,
		`HTTP ${status}`
	].filter(Boolean);
	return `${message} (${details.join(", ")})`;
}

/* ── Typed endpoints ─────────────────────────────────────────────────────── */

export function getHealth(init?: ApiRequestInit): Promise<HealthResponse> {
	return apiRequest("/api/v1/health", healthResponseSchema, init);
}

export function getSystemStatus(init?: ApiRequestInit): Promise<SystemStatus> {
	return apiRequest("/api/v1/system/status", systemStatusSchema, init);
}

/** Load build metadata independently of database-backed system status. */
export function getSystemInfo(init?: ApiRequestInit): Promise<SystemInfo> {
	return apiRequest("/api/v1/system/info", systemInfoSchema, {
		...init,
		// Build identity and uptime must reflect the server handling this request.
		cache: "no-store"
	});
}

export function listTuners(init?: ApiRequestInit): Promise<TunerList> {
	return apiRequest("/api/v1/tuners", tunerListSchema, init);
}

export function discoverTuners(
	init?: ApiRequestInit
): Promise<TunerDiscoveryResponse> {
	return apiRequest("/api/v1/tuners/discover", tunerDiscoveryResponseSchema, {
		...init,
		method: "POST"
	});
}

export function createTuner(
	body: TunerCreate,
	init?: ApiRequestInit
): Promise<Tuner> {
	return apiRequest("/api/v1/tuners", tunerSchema, {
		...init,
		method: "POST",
		json: tunerCreateSchema.parse(body)
	});
}

export function updateTuner(
	id: string,
	body: TunerPatch,
	init?: ApiRequestInit
): Promise<Tuner> {
	return apiRequest(`/api/v1/tuners/${encodeURIComponent(id)}`, tunerSchema, {
		...init,
		method: "PATCH",
		json: tunerPatchSchema.parse(body)
	});
}

export async function deleteTuner(
	id: string,
	init?: ApiRequestInit
): Promise<void> {
	await apiRequest(`/api/v1/tuners/${encodeURIComponent(id)}`, z.unknown(), {
		...init,
		method: "DELETE"
	});
}

/**
 * Snapshot of a tuner's reachability / online state. Backed by the
 * provider's `getStatus()` and intended for the Settings UI's "tuner
 * reachable" badge — callers should treat the response as best-effort
 * (some providers may return a stale-but-recent value).
 */
export function getTunerStatus(
	id: string,
	init?: ApiRequestInit
): Promise<TunerStatus> {
	return apiRequest(
		`/api/v1/tuners/${encodeURIComponent(id)}/status`,
		tunerStatusSchema,
		init
	);
}

/** Live HDHomeRun RF metrics are available only while the channel is tuned. */
export function getChannelQuality(
	id: string,
	init?: ApiRequestInit
): Promise<ChannelQuality> {
	return apiRequest(
		`/api/v1/channels/${encodeURIComponent(id)}/quality`,
		channelQualitySchema,
		init
	);
}

/** Active FFmpeg processes shown by the advanced operations page. */
export function listFfmpegWork(init?: ApiRequestInit): Promise<FfmpegWorkList> {
	return apiRequest("/api/v1/advanced/ffmpeg", ffmpegWorkListSchema, init);
}

/** Get the public IP address observed from the SignalHaven server. */
export function getExternalIp(
	init?: ApiRequestInit
): Promise<ExternalIpResponse> {
	return apiRequest(
		"/api/v1/advanced/external-ip",
		externalIpResponseSchema,
		init
	);
}

/** Request a graceful stop for one live stream or recording process. */
export async function stopFfmpegWork(
	id: string,
	init?: ApiRequestInit
): Promise<void> {
	await apiRequest(
		`/api/v1/advanced/ffmpeg/${encodeURIComponent(id)}`,
		z.unknown(),
		{ ...init, method: "DELETE" }
	);
}

/** Backend half of the player's extra-statistics overlay. */
export function getStreamStatus(
	channelId: string,
	quality?: string,
	init?: ApiRequestInit
): Promise<StreamStatus> {
	const suffix =
		quality && quality !== "auto"
			? `?${new URLSearchParams({ profile: quality }).toString()}`
			: "";
	return apiRequest(
		`/api/v1/stream/${encodeURIComponent(channelId)}/status${suffix}`,
		streamStatusSchema,
		init
	);
}

/** Include server error codes, request ids, and details only for operators. */
export function formatClientError(
	error: unknown,
	fallback: string,
	advanced: boolean
): string {
	if (!(error instanceof ApiError)) {
		return error instanceof Error ? error.message : fallback;
	}
	if (!advanced) return fallback;
	const body = error.body as {
		error?: { code?: string; message?: string; requestId?: string };
	} | null;
	const server = body?.error;
	const message = server?.message ?? error.message;
	const metadata = [
		server?.code ? `code: ${server.code}` : null,
		server?.requestId ? `request: ${server.requestId}` : null,
		`HTTP ${error.status}`
	].filter(Boolean);
	return `${message} (${metadata.join(", ")})`;
}

/**
 * Sync a tuner's channel lineup into the DB. Inserts new channels, updates
 * changed display names / logos, and tracks consecutive misses before removal.
 * The endpoint forces a fresh provider read and returns reconciliation counts.
 */
export function syncTunerChannels(
	id: string,
	init?: ApiRequestInit
): Promise<TunerSyncResponse> {
	return apiRequest(
		`/api/v1/tuners/${encodeURIComponent(id)}/sync`,
		tunerSyncResponseSchema,
		{ ...init, method: "POST" }
	);
}

export function listEpgSources(init?: ApiRequestInit): Promise<EpgSourceList> {
	return apiRequest("/api/v1/epg/sources", epgSourceListSchema, init);
}

export function createEpgSource(
	body: EpgSourceCreate,
	init?: ApiRequestInit
): Promise<EpgSource> {
	return apiRequest("/api/v1/epg/sources", epgSourceSchema, {
		...init,
		method: "POST",
		json: epgSourceCreateSchema.parse(body)
	});
}

export function updateEpgSource(
	id: string,
	body: EpgSourcePatch,
	init?: ApiRequestInit
): Promise<EpgSource> {
	return apiRequest(
		`/api/v1/epg/sources/${encodeURIComponent(id)}`,
		epgSourceSchema,
		{
			...init,
			method: "PATCH",
			json: epgSourcePatchSchema.parse(body)
		}
	);
}

export async function deleteEpgSource(
	id: string,
	init?: ApiRequestInit
): Promise<void> {
	await apiRequest(
		`/api/v1/epg/sources/${encodeURIComponent(id)}`,
		z.unknown(),
		{ ...init, method: "DELETE" }
	);
}

/**
 * Manually trigger an EPG refresh. The backend processes asynchronously
 * and also publishes incremental progress on the `epg` WS topic; this
 * call resolves with the final import counts (HTTP 202).
 */
export function refreshEpgSource(
	id: string,
	init?: ApiRequestInit
): Promise<EpgRefreshResult> {
	return apiRequest(
		`/api/v1/epg/sources/${encodeURIComponent(id)}/refresh`,
		epgRefreshResultSchema,
		{ ...init, method: "POST" }
	);
}

/**
 * Fetch the EPG grid (channels + programs) for the given window. Used by
 * the live grid guide; both bounds are ISO 8601 strings (UTC recommended).
 */
export function getEpgGrid(
	params: { from: string; to: string },
	init?: ApiRequestInit
): Promise<EpgGrid> {
	const search = new URLSearchParams({ from: params.from, to: params.to });
	return apiRequest(
		`/api/v1/epg/grid?${search.toString()}`,
		epgGridSchema,
		init
	);
}

/** Fetch one search-selected program with live recording state and channel. */
export function getEpgProgram(
	id: string,
	init?: ApiRequestInit
): Promise<EpgProgramDetails> {
	return apiRequest(
		`/api/v1/epg/programs/${encodeURIComponent(id)}`,
		epgProgramDetailsSchema,
		init
	);
}

/**
 * Fetch the channel-centric list (U5-channels). Always returned in the
 * server's canonical `sortOrder`; the UI overlays the user-customisable
 * order from `settings.channels.order` on top.
 */
export function listChannels(init?: ApiRequestInit): Promise<ChannelList> {
	return apiRequest("/api/v1/channels", channelListSchema, init);
}

/** Group logical channels while keeping the selected primary id stable. */
export function mergeChannels(
	body: ChannelMerge,
	init?: ApiRequestInit
): Promise<ChannelList> {
	return apiRequest("/api/v1/channels/merge", channelListSchema, {
		...init,
		method: "POST",
		json: channelMergeSchema.parse(body)
	});
}

/** Separate one physical source into its own user-facing channel. */
export function splitChannelSource(
	channelId: string,
	sourceId: string,
	init?: ApiRequestInit
): Promise<ChannelList> {
	return apiRequest(
		`/api/v1/channels/${encodeURIComponent(channelId)}/sources/${encodeURIComponent(sourceId)}/split`,
		channelListSchema,
		{ ...init, method: "POST" }
	);
}

/** Promote one healthy source to the front of automatic selection. */
export function preferChannelSource(
	channelId: string,
	sourceId: string,
	init?: ApiRequestInit
): Promise<ChannelList> {
	return apiRequest(
		`/api/v1/channels/${encodeURIComponent(channelId)}/sources/${encodeURIComponent(sourceId)}/preferred`,
		channelListSchema,
		{ ...init, method: "POST" }
	);
}

export function getSettings(init?: ApiRequestInit): Promise<Settings> {
	return apiRequest("/api/v1/settings", settingsSchema, init);
}

export function updateSettings(
	body: SettingsPatch,
	init?: ApiRequestInit
): Promise<Settings> {
	return apiRequest("/api/v1/settings", settingsSchema, {
		...init,
		method: "PATCH",
		json: settingsPatchSchema.parse(body)
	});
}

/* ── Recordings (rrainn/SignalHaven#U8-recordings) ─────────────────────────────── */

/**
 * Build the playback URL for a recording. The frontend treats the
 * recordings library as an HLS source so the same {@link Player}
 * component can be reused for both live and on-demand playback. The
 * actual backend endpoint is part of the DVR library service
 * (`rrainn/SignalHaven#24`); the convention is mirrored here so the route
 * stays in one place.
 */
export function buildRecordingPlaybackUrl(
	recordingId: string,
	startSeconds = 0
): string {
	const path = `/api/v1/recordings/${encodeURIComponent(recordingId)}/stream.m3u8`;
	// Keep the canonical zero-offset URL stable for caches, tests, and logs.
	return startSeconds > 0
		? `${path}?${new URLSearchParams({ start: String(Math.floor(startSeconds)) })}`
		: path;
}

/**
 * Preflight the HLS manifest before mounting the player. This turns recording
 * lifecycle and file errors into readable API messages instead of an opaque
 * media-element failure while also warming the reusable playback session.
 */
export async function prepareRecordingPlayback(
	recordingId: string,
	startSeconds = 0,
	init: RequestInit = {}
): Promise<void> {
	const path = buildRecordingPlaybackUrl(recordingId, startSeconds);
	const headers = new Headers(init.headers);
	headers.set("Accept", "application/vnd.apple.mpegurl");
	const response = await fetch(buildUrl(path), { ...init, headers });
	const body = await response.text();
	if (!response.ok) {
		let payload: unknown = body;
		try {
			payload = body.length > 0 ? JSON.parse(body) : undefined;
		} catch {
			// Preserve a non-JSON response for diagnostics.
		}
		throw new ApiError(
			readApiErrorMessage(payload) ??
				`Request failed: ${response.status} ${response.statusText}`,
			response.status,
			payload
		);
	}
	if (!body.startsWith("#EXTM3U")) {
		throw new ApiError("Playback manifest was invalid", response.status, body);
	}
}

/** Read the standardized backend message without trusting arbitrary payloads. */
function readApiErrorMessage(payload: unknown): string | null {
	if (!payload || typeof payload !== "object") return null;
	const error = (payload as { error?: unknown }).error;
	if (!error || typeof error !== "object") return null;
	const message = (error as { message?: unknown }).message;
	return typeof message === "string" && message.length > 0 ? message : null;
}

/**
 * Fetch the (paginated, filtered) recordings library list. All filter
 * fields are optional; the server supplies sensible defaults for
 * `limit` / `offset` / `sort` / `direction`.
 */
export function listRecordings(
	query: Partial<RecordingListQuery> = {},
	init?: ApiRequestInit
): Promise<RecordingList> {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null) continue;
		search.set(key, String(value));
	}
	const qs = search.toString();
	return apiRequest(
		qs.length > 0 ? `/api/v1/recordings?${qs}` : "/api/v1/recordings",
		recordingListSchema,
		init
	);
}

/**
 * Exhaust a deliberately filtered recordings query through bounded cursor
 * pages. Non-library consumers such as Scheduler use this when their domain
 * requires every matching row rather than an interactive paginator.
 */
export async function listAllRecordings(
	query: Partial<RecordingListQuery>,
	init?: ApiRequestInit
): Promise<Recording[]> {
	const rows: Recording[] = [];
	const seen = new Set<string>();
	const seenCursors = new Set<string>();
	let cursor: string | undefined;
	let offset = 0;
	do {
		const page = await listRecordings(
			{
				...query,
				limit: RECORDING_LIST_MAX_LIMIT,
				offset,
				...(cursor ? { cursor } : {})
			},
			init
		);
		for (const recording of page.items) {
			if (seen.has(recording.id)) continue;
			seen.add(recording.id);
			rows.push(recording);
		}
		offset = rows.length;
		cursor = page.nextCursor ?? undefined;
		if (cursor && seenCursors.has(cursor)) {
			throw new ApiError("Recordings pagination cursor repeated", 502, {
				cursor
			});
		}
		if (cursor) seenCursors.add(cursor);
	} while (cursor);
	return rows;
}

/**
 * Fetch a single recording (with EPG-derived metadata) by id. Used by
 * the recordings playback page to seed `resumePositionSeconds` and to
 * surface the episode title / artwork in the chrome around the player.
 */
export function getRecording(
	id: string,
	init?: ApiRequestInit
): Promise<RecordingDetail> {
	return apiRequest(
		`/api/v1/recordings/${encodeURIComponent(id)}`,
		recordingDetailSchema,
		init
	);
}

/** Queue a safe, idempotent retry of post-recording commercial analysis. */
export function retryCommercialAnalysis(
	id: string,
	init?: ApiRequestInit
): Promise<CommercialAnalysis> {
	return apiRequest(
		`/api/v1/recordings/${encodeURIComponent(id)}/commercial-analysis/retry`,
		commercialAnalysisSchema,
		{ ...init, method: "POST" }
	);
}

/**
 * Patch a recording's library bookkeeping (mark watched, update resume
 * position, toggle the manually-protected flag). Used by the player to
 * persist progress on a debounced timer + on the unmount path.
 */
export function patchRecording(
	id: string,
	body: RecordingPatch,
	init?: ApiRequestInit
): Promise<Recording> {
	return apiRequest(
		`/api/v1/recordings/${encodeURIComponent(id)}`,
		recordingSchema,
		{
			...init,
			method: "PATCH",
			json: recordingPatchSchema.parse(body)
		}
	);
}

/**
 * Permanently delete a recording (file + row by default). The library
 * UI uses a confirmation dialog before invoking this.
 */
export async function deleteRecording(
	id: string,
	options: {
		keepFile?: boolean;
		overrideProtection?: boolean;
	} = {},
	init?: ApiRequestInit
): Promise<void> {
	const query = new URLSearchParams();
	if (options.keepFile) query.set("keepFile", "true");
	if (options.overrideProtection) {
		query.set("overrideProtection", "true");
	}
	const suffix = query.toString();
	await apiRequest(
		`/api/v1/recordings/${encodeURIComponent(id)}${suffix ? `?${suffix}` : ""}`,
		z.unknown(),
		{
			...init,
			method: "DELETE"
		}
	);
}

/* ── Scheduler (rrainn/SignalHaven#U9-scheduler) ──────────────────────────────── */

/**
 * Schedule a one-off recording from explicit channel + window. Used by
 * the scheduler's "Record" button when no EPG program is available.
 */
export function createRecording(
	body: RecordingCreate,
	init?: ApiRequestInit
): Promise<Recording> {
	return apiRequest("/api/v1/recordings", recordingSchema, {
		...init,
		method: "POST",
		json: recordingCreateSchema.parse(body)
	});
}

/**
 * Schedule a one-off recording from an EPG program id. The backend
 * resolves the channel via the channel ↔ EPG mapping and applies the
 * configured padding to the program's `start` / `stop`.
 */
export function scheduleRecordingByProgram(
	body: RecordingByProgramCreate,
	init?: ApiRequestInit
): Promise<RecordingByProgramResponse> {
	return apiRequest(
		"/api/v1/recordings/by-program",
		recordingByProgramResponseSchema,
		{
			...init,
			method: "POST",
			json: recordingByProgramCreateSchema.parse(body)
		}
	);
}

/**
 * Cancel a scheduled or in-progress recording (transitions the row to
 * `cancelled`). Used by the upcoming-recordings list's quick-cancel
 * button.
 */
export function cancelRecording(
	id: string,
	init?: ApiRequestInit
): Promise<Recording> {
	return apiRequest(
		`/api/v1/recordings/${encodeURIComponent(id)}/cancel`,
		recordingSchema,
		{ ...init, method: "POST" }
	);
}

/**
 * List the configured series rules ("season passes"). The scheduler's
 * series-rules manager renders these in a table with edit + delete
 * controls.
 */
export function listSeriesRules(
	init?: ApiRequestInit
): Promise<SeriesRuleList> {
	return apiRequest("/api/v1/series-rules", seriesRuleListSchema, init);
}

export function createSeriesRule(
	body: SeriesRuleCreate,
	init?: ApiRequestInit
): Promise<SeriesRule> {
	return apiRequest("/api/v1/series-rules", seriesRuleSchema, {
		...init,
		method: "POST",
		json: seriesRuleCreateSchema.parse(body)
	});
}

export function updateSeriesRule(
	id: string,
	body: SeriesRulePatch,
	init?: ApiRequestInit
): Promise<SeriesRule> {
	return apiRequest(
		`/api/v1/series-rules/${encodeURIComponent(id)}`,
		seriesRuleSchema,
		{
			...init,
			method: "PATCH",
			json: seriesRulePatchSchema.parse(body)
		}
	);
}

export async function deleteSeriesRule(
	id: string,
	init?: ApiRequestInit
): Promise<void> {
	await apiRequest(
		`/api/v1/series-rules/${encodeURIComponent(id)}`,
		z.unknown(),
		{
			...init,
			method: "DELETE"
		}
	);
}

/**
 * Snapshot of the conflicts surfaced by the most recent series-rule
 * evaluation passes. Clients should also subscribe to the WS
 * `recordings` topic for real-time `recording.conflict` events.
 */
export function listRecordingConflicts(
	init?: ApiRequestInit
): Promise<RecordingConflictList> {
	return apiRequest(
		"/api/v1/recordings/conflicts",
		recordingConflictListSchema,
		init
	);
}

/**
 * Re-export `z` so endpoint modules can build ad-hoc schemas (e.g. arrays
 * of a base schema) without pulling zod directly into every callsite.
 */
export { z };

/* ── Global search (rrainn/SignalHaven#U10-search) ─────────────────────────────── */

/**
 * Run a global search across channels, upcoming programs, and
 * recordings. The caller is responsible for cancelling the request via
 * `init.signal` (an `AbortController`); the search modal does this on
 * every keystroke so only the latest in-flight request is honoured.
 *
 * Returns an empty grouping for blank `q` (the backend short-circuits
 * before touching the database).
 */
export function searchAll(
	q: string,
	options: { limit?: number } = {},
	init?: ApiRequestInit
): Promise<SearchResponse> {
	const search = new URLSearchParams({ q });
	if (options.limit !== undefined) {
		search.set("limit", String(options.limit));
	}
	return apiRequest(
		`/api/v1/search?${search.toString()}`,
		searchResponseSchema,
		{
			...init,
			// Search reflects a mutable guide snapshot; a cached response can point
			// at a program that a subsequent refresh has already removed.
			cache: "no-store"
		}
	);
}
