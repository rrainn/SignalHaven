import {
	channelEpgMappingPutSchema,
	channelEpgMappingSchema,
	channelListSchema,
	channelMergeSchema,
	epgCandidatesResponseSchema,
	epgGridSchema,
	epgProgramDetailsSchema,
	epgRefreshResultSchema,
	epgSourceCreateSchema,
	epgSourceListSchema,
	epgSourcePatchSchema,
	epgSourceSchema,
	errorResponseSchema,
	healthResponseSchema,
	recordingByProgramCreateSchema,
	recordingByProgramResponseSchema,
	recordingConflictListSchema,
	recordingCreateSchema,
	recordingDeleteQuerySchema,
	recordingDetailSchema,
	recordingLibraryScanResultSchema,
	recordingListQuerySchema,
	recordingListSchema,
	recordingPatchSchema,
	recordingSchema,
	searchQuerySchema,
	searchResponseSchema,
	seriesRuleCreateSchema,
	seriesRuleListSchema,
	seriesRulePatchSchema,
	seriesRuleSchema,
	settingsPatchSchema,
	settingsSchema,
	systemInfoSchema,
	systemStatusSchema,
	tunerActivityResponseSchema,
	tunerCreateSchema,
	tunerDiscoveryResponseSchema,
	tunerListSchema,
	tunerPatchSchema,
	tunerSchema,
	tunerStatusSchema,
	transcodeProfileSchema
} from "@signalhaven/shared";
import {
	OpenAPIRegistry,
	OpenApiGeneratorV31,
	extendZodWithOpenApi
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import { getVersion } from "../version";

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

const HealthResponse = registry.register(
	"HealthResponse",
	healthResponseSchema
);
const ErrorResponse = registry.register("ErrorResponse", errorResponseSchema);
const Settings = registry.register("Settings", settingsSchema);
const SettingsPatch = registry.register("SettingsPatch", settingsPatchSchema);
const SystemStatus = registry.register("SystemStatus", systemStatusSchema);
const SystemInfo = registry.register("SystemInfo", systemInfoSchema);
const Tuner = registry.register("Tuner", tunerSchema);
const TunerCreate = registry.register("TunerCreate", tunerCreateSchema);
const TunerPatch = registry.register("TunerPatch", tunerPatchSchema);
const TunerList = registry.register("TunerList", tunerListSchema);
const TunerDiscoveryResponse = registry.register(
	"TunerDiscoveryResponse",
	tunerDiscoveryResponseSchema
);
const TunerActivityResponse = registry.register(
	"TunerActivityResponse",
	tunerActivityResponseSchema
);
const TunerStatus = registry.register("TunerStatus", tunerStatusSchema);
const EpgSource = registry.register("EpgSource", epgSourceSchema);
const EpgSourceCreate = registry.register(
	"EpgSourceCreate",
	epgSourceCreateSchema
);
const EpgSourcePatch = registry.register(
	"EpgSourcePatch",
	epgSourcePatchSchema
);
const EpgSourceList = registry.register("EpgSourceList", epgSourceListSchema);
const EpgRefreshResult = registry.register(
	"EpgRefreshResult",
	epgRefreshResultSchema
);
const EpgCandidatesResponse = registry.register(
	"EpgCandidatesResponse",
	epgCandidatesResponseSchema
);
const EpgGrid = registry.register("EpgGrid", epgGridSchema);
const EpgProgramDetails = registry.register(
	"EpgProgramDetails",
	epgProgramDetailsSchema
);
const ChannelEpgMapping = registry.register(
	"ChannelEpgMapping",
	channelEpgMappingSchema
);
const ChannelEpgMappingPut = registry.register(
	"ChannelEpgMappingPut",
	channelEpgMappingPutSchema
);
const ChannelList = registry.register("ChannelList", channelListSchema);
const ChannelMerge = registry.register("ChannelMerge", channelMergeSchema);
const Recording = registry.register("Recording", recordingSchema);
const RecordingCreate = registry.register(
	"RecordingCreate",
	recordingCreateSchema
);
const RecordingByProgramCreate = registry.register(
	"RecordingByProgramCreate",
	recordingByProgramCreateSchema
);
const RecordingByProgramResponse = registry.register(
	"RecordingByProgramResponse",
	recordingByProgramResponseSchema
);
const RecordingList = registry.register("RecordingList", recordingListSchema);
const RecordingDetail = registry.register(
	"RecordingDetail",
	recordingDetailSchema
);
const RecordingPatch = registry.register(
	"RecordingPatch",
	recordingPatchSchema
);
const RecordingLibraryScanResult = registry.register(
	"RecordingLibraryScanResult",
	recordingLibraryScanResultSchema
);
const SeriesRule = registry.register("SeriesRule", seriesRuleSchema);
const SeriesRuleCreate = registry.register(
	"SeriesRuleCreate",
	seriesRuleCreateSchema
);
const SeriesRulePatch = registry.register(
	"SeriesRulePatch",
	seriesRulePatchSchema
);
const SeriesRuleList = registry.register(
	"SeriesRuleList",
	seriesRuleListSchema
);
const RecordingConflictList = registry.register(
	"RecordingConflictList",
	recordingConflictListSchema
);
const SearchQuery = registry.register("SearchQuery", searchQuerySchema);
const SearchResponse = registry.register(
	"SearchResponse",
	searchResponseSchema
);

registry.registerPath({
	method: "get",
	path: "/api/v1/health",
	summary: "Service health check",
	description:
		"Returns the API version, process uptime in seconds, and database connectivity status.",
	tags: ["health"],
	responses: {
		200: {
			description: "Service is healthy.",
			content: {
				"application/json": {
					schema: HealthResponse
				}
			}
		},
		503: {
			description: "Service is unhealthy (e.g. database is unreachable).",
			content: {
				"application/json": {
					schema: HealthResponse
				}
			}
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/system/info",
	summary: "Application build and runtime information",
	description:
		"Returns the release version, Git commit, and current server-process uptime.",
	tags: ["system"],
	responses: {
		200: {
			description: "Application metadata and server uptime.",
			content: {
				"application/json": {
					schema: SystemInfo
				}
			}
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/openapi.json",
	summary: "OpenAPI 3.1 specification for this API.",
	tags: ["meta"],
	responses: {
		200: {
			description: "OpenAPI document.",
			content: {
				"application/json": {
					schema: z.record(z.string(), z.unknown())
				}
			}
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/settings",
	summary: "Get all user-configurable settings",
	description:
		"Returns the merged settings document. Unset keys are filled in from the server-side defaults.",
	tags: ["settings"],
	responses: {
		200: {
			description: "Current settings.",
			content: {
				"application/json": { schema: Settings }
			}
		}
	}
});

registry.registerPath({
	method: "patch",
	path: "/api/v1/settings",
	summary: "Partially update settings",
	description:
		"Validates and persists each provided top-level key. Keys not present in the body are left unchanged.",
	tags: ["settings"],
	request: {
		body: {
			required: true,
			content: {
				"application/json": { schema: SettingsPatch }
			}
		}
	},
	responses: {
		200: {
			description: "Updated settings document.",
			content: {
				"application/json": { schema: Settings }
			}
		},
		400: {
			description: "Invalid settings patch.",
			content: {
				"application/json": { schema: ErrorResponse }
			}
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/system/status",
	summary: "High-level system status used to drive onboarding UX",
	tags: ["system"],
	responses: {
		200: {
			description: "System status flags.",
			content: {
				"application/json": { schema: SystemStatus }
			}
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/tuners",
	summary: "List configured tuners",
	tags: ["tuners"],
	responses: {
		200: {
			description: "All persisted tuners.",
			content: { "application/json": { schema: TunerList } }
		}
	}
});

registry.registerPath({
	method: "post",
	path: "/api/v1/tuners",
	summary: "Register a new tuner",
	description:
		"Body is validated per `kind` via a discriminated zod schema. Returns the persisted record.",
	tags: ["tuners"],
	request: {
		body: {
			required: true,
			content: { "application/json": { schema: TunerCreate } }
		}
	},
	responses: {
		201: {
			description: "Tuner created.",
			content: { "application/json": { schema: Tuner } }
		},
		400: {
			description: "Invalid body.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "post",
	path: "/api/v1/tuners/discover",
	summary: "Auto-discover tuners on the local network",
	description:
		"Delegates to every registered provider; results are also published on the WS event bus under topic `tuners`, event `discovered`.",
	tags: ["tuners"],
	responses: {
		200: {
			description: "Discovery results.",
			content: { "application/json": { schema: TunerDiscoveryResponse } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/tuners/activity",
	summary: "List active tuner leases",
	description:
		"Snapshot of every active lease tracked by the in-process tuner allocator. Counterpart to the `lease.acquired` / `lease.released` / `lease.preempted` events on the `tuners` WS topic.",
	tags: ["tuners"],
	responses: {
		200: {
			description: "Active tuner leases.",
			content: { "application/json": { schema: TunerActivityResponse } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/tuners/{id}",
	summary: "Get a single tuner by id",
	tags: ["tuners"],
	request: {
		params: z.object({ id: z.string().uuid() })
	},
	responses: {
		200: {
			description: "The tuner.",
			content: { "application/json": { schema: Tuner } }
		},
		404: {
			description: "Tuner not found.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/tuners/{id}/status",
	summary: "Get a tuner's live reachability status",
	description:
		"Snapshot of the underlying provider's `getStatus()` (online/offline + diagnostic message). Provider failures are surfaced as `online: false` so the UI can render a single status badge without a separate error path.",
	tags: ["tuners"],
	request: {
		params: z.object({ id: z.string().uuid() })
	},
	responses: {
		200: {
			description: "Tuner status.",
			content: { "application/json": { schema: TunerStatus } }
		},
		404: {
			description: "Tuner not found.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "patch",
	path: "/api/v1/tuners/{id}",
	summary: "Partially update a tuner",
	description:
		"When updating `config`, `kind` must also be supplied so the body can be validated against the per-kind schema.",
	tags: ["tuners"],
	request: {
		params: z.object({ id: z.string().uuid() }),
		body: {
			required: true,
			content: { "application/json": { schema: TunerPatch } }
		}
	},
	responses: {
		200: {
			description: "Updated tuner.",
			content: { "application/json": { schema: Tuner } }
		},
		400: {
			description: "Invalid body.",
			content: { "application/json": { schema: ErrorResponse } }
		},
		404: {
			description: "Tuner not found.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "delete",
	path: "/api/v1/tuners/{id}",
	summary: "Delete a tuner",
	tags: ["tuners"],
	request: {
		params: z.object({ id: z.string().uuid() })
	},
	responses: {
		204: { description: "Deleted." },
		404: {
			description: "Tuner not found.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/tuners/{id}/channels/{channelId}/logo",
	summary: "Proxy a channel logo through the API origin",
	description:
		"Returns the cached channel logo bytes for tuner kinds that expose them (e.g. IPTV/M3U). Reproxying through our origin lets an HTTPS UI render logos that the playlist references over HTTP.",
	tags: ["tuners"],
	request: {
		params: z.object({
			id: z.string().uuid(),
			channelId: z.string().min(1).max(128)
		})
	},
	responses: {
		200: {
			description: "Logo bytes with the upstream `Content-Type`.",
			content: { "image/*": { schema: { type: "string", format: "binary" } } }
		},
		404: {
			description: "Tuner missing, channel unknown, or logo unavailable.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/epg/sources",
	summary: "List configured EPG sources",
	tags: ["epg"],
	responses: {
		200: {
			description: "All persisted EPG sources.",
			content: { "application/json": { schema: EpgSourceList } }
		}
	}
});

registry.registerPath({
	method: "post",
	path: "/api/v1/epg/sources",
	summary: "Register a new EPG source",
	description:
		"Create an XMLTV source from a URL/file path or link an HDHomeRun guide to a configured tuner.",
	tags: ["epg"],
	request: {
		body: {
			required: true,
			content: { "application/json": { schema: EpgSourceCreate } }
		}
	},
	responses: {
		201: {
			description: "EPG source created.",
			content: { "application/json": { schema: EpgSource } }
		},
		400: {
			description: "Invalid body.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/epg/sources/{id}",
	summary: "Get a single EPG source by id",
	tags: ["epg"],
	request: { params: z.object({ id: z.string().uuid() }) },
	responses: {
		200: {
			description: "The EPG source.",
			content: { "application/json": { schema: EpgSource } }
		},
		404: {
			description: "Source not found.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "patch",
	path: "/api/v1/epg/sources/{id}",
	summary: "Partially update an EPG source",
	tags: ["epg"],
	request: {
		params: z.object({ id: z.string().uuid() }),
		body: {
			required: true,
			content: { "application/json": { schema: EpgSourcePatch } }
		}
	},
	responses: {
		200: {
			description: "Updated source.",
			content: { "application/json": { schema: EpgSource } }
		},
		404: {
			description: "Source not found.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "delete",
	path: "/api/v1/epg/sources/{id}",
	summary: "Delete an EPG source",
	tags: ["epg"],
	request: { params: z.object({ id: z.string().uuid() }) },
	responses: {
		204: { description: "Deleted." },
		404: {
			description: "Source not found.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "post",
	path: "/api/v1/epg/sources/{id}/refresh",
	summary: "Manually refresh an EPG source",
	description:
		"Streams the source's XMLTV feed into the database. Progress is also published incrementally on the `epg` WebSocket topic under event `epg.refresh`.",
	tags: ["epg"],
	request: { params: z.object({ id: z.string().uuid() }) },
	responses: {
		202: {
			description: "Import counts.",
			content: { "application/json": { schema: EpgRefreshResult } }
		},
		404: {
			description: "Source not found.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/epg/grid",
	summary: "Load a bounded Guide window",
	tags: ["epg"],
	request: {
		query: z.object({ from: z.string(), to: z.string() })
	},
	responses: {
		200: {
			description: "Mapped channels and programs intersecting the window.",
			content: { "application/json": { schema: EpgGrid } }
		},
		400: {
			description: "Invalid or reversed time bounds.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/epg/programs/{id}",
	summary: "Load program details with current recording state",
	tags: ["epg"],
	request: { params: z.object({ id: z.string().uuid() }) },
	responses: {
		200: {
			description: "The program and its mapped tuner channel.",
			content: { "application/json": { schema: EpgProgramDetails } }
		},
		404: {
			description: "Program was deleted, unmapped, or is no longer available.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/channels",
	summary: "List logical channels and their tuner sources",
	description:
		"Returns one stable user-facing channel per group, with physical tuner sources ordered for automatic fallback. Missing sources remain linked; unavailable sources stay visible for recovery but are not selected for playback.",
	tags: ["channels"],
	responses: {
		200: {
			description: "Logical channels with their ordered source variants.",
			content: { "application/json": { schema: ChannelList } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/channels/{id}/logo",
	summary: "Proxy a logical channel logo through the API origin",
	description:
		"Resolves the preferred physical source, validates the provider image, and returns bounded cached bytes without exposing the provider URL to the browser.",
	tags: ["channels"],
	request: { params: z.object({ id: z.string().uuid() }) },
	responses: {
		200: {
			description: "Channel logo bytes.",
			content: { "image/*": { schema: { type: "string", format: "binary" } } }
		},
		404: {
			description: "Channel or logo not found.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "post",
	path: "/api/v1/channels/merge",
	summary: "Merge channels into one multi-source identity",
	description:
		"Moves every selected source, recording, and series rule to the chosen primary logical channel. The primary id and guide mapping remain stable.",
	tags: ["channels"],
	request: {
		body: {
			required: true,
			content: { "application/json": { schema: ChannelMerge } }
		}
	},
	responses: {
		200: {
			description: "Updated logical channel list.",
			content: { "application/json": { schema: ChannelList } }
		},
		409: {
			description: "The selected channels cannot be merged.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "post",
	path: "/api/v1/channels/{id}/sources/{sourceId}/split",
	summary: "Separate a tuner source into its own channel",
	tags: ["channels"],
	request: {
		params: z.object({ id: z.string().uuid(), sourceId: z.string().uuid() })
	},
	responses: {
		200: {
			description: "Updated logical channel list.",
			content: { "application/json": { schema: ChannelList } }
		},
		409: {
			description:
				"The source does not belong to the group or is already alone.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "post",
	path: "/api/v1/channels/{id}/sources/{sourceId}/preferred",
	summary: "Choose the preferred source for a channel",
	description:
		"Promotes an active source to the front of fallback order and adopts its public channel metadata.",
	tags: ["channels"],
	request: {
		params: z.object({ id: z.string().uuid(), sourceId: z.string().uuid() })
	},
	responses: {
		200: {
			description: "Updated logical channel list.",
			content: { "application/json": { schema: ChannelList } }
		},
		409: {
			description: "The source is unavailable or does not belong to the group.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/channels/{id}/epg-candidates",
	summary: "Ranked EPG channel candidates for a tuner channel",
	description:
		"Returns EPG channels ordered by match confidence. Strategies are tried in this order: tvg-id, exact display-name, normalized name, channel-number prefix.",
	tags: ["channels"],
	request: { params: z.object({ id: z.string().uuid() }) },
	responses: {
		200: {
			description: "Ranked candidates.",
			content: { "application/json": { schema: EpgCandidatesResponse } }
		},
		404: {
			description: "Channel not found.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "put",
	path: "/api/v1/channels/{id}/epg-mapping",
	summary: "Manually set the EPG channel for a tuner channel",
	description:
		"Persists a manual mapping that the auto-matcher will not overwrite on subsequent EPG refreshes.",
	tags: ["channels"],
	request: {
		params: z.object({ id: z.string().uuid() }),
		body: {
			required: true,
			content: { "application/json": { schema: ChannelEpgMappingPut } }
		}
	},
	responses: {
		200: {
			description: "Persisted mapping.",
			content: { "application/json": { schema: ChannelEpgMapping } }
		},
		404: {
			description: "Channel or EPG channel not found.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/stream/{channelId}/master.m3u8",
	summary: "HLS master playlist for a channel",
	description:
		"Attaches an HTTP client to the per-channel `StreamSession`, spinning up ffmpeg + acquiring a tuner lease the first time. A browser-generated `viewerId` retains the session across short HLS requests until its release beacon arrives.",
	tags: ["streaming"],
	request: {
		params: z.object({ channelId: z.string().min(1).max(128) }),
		query: z.object({
			profile: transcodeProfileSchema.optional(),
			viewerId: z.string().uuid().optional()
		})
	},
	responses: {
		200: {
			description: "HLS master playlist (synthetic, points at media playlist).",
			content: {
				"application/vnd.apple.mpegurl": {
					schema: { type: "string" }
				}
			}
		},
		404: {
			description: "Channel unknown or not streamable.",
			content: { "application/json": { schema: ErrorResponse } }
		},
		409: {
			description: "No tuner capacity available.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/stream/{channelId}/playlist.m3u8",
	summary: "HLS media playlist for a channel",
	tags: ["streaming"],
	request: {
		params: z.object({ channelId: z.string().min(1).max(128) }),
		query: z.object({
			profile: transcodeProfileSchema.optional(),
			viewerId: z.string().uuid().optional()
		})
	},
	responses: {
		200: {
			description: "HLS media playlist.",
			content: {
				"application/vnd.apple.mpegurl": {
					schema: { type: "string" }
				}
			}
		},
		404: {
			description: "Channel unknown or no active session.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "post",
	path: "/api/v1/stream/{channelId}/viewers/{viewerId}/release",
	summary: "Release a live-stream viewer",
	description:
		"Idempotently releases one browser player. When it was the final registered viewer, the server stops FFmpeg and releases the tuner immediately.",
	tags: ["streaming"],
	request: {
		params: z.object({
			channelId: z.string().min(1).max(128),
			viewerId: z.string().uuid()
		}),
		query: z.object({ profile: transcodeProfileSchema.optional() })
	},
	responses: {
		204: { description: "Viewer released or already absent." }
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/stream/{channelId}/segments/{segment}",
	summary: "HLS segment bytes",
	description:
		"Serves a single segment file generated by the per-channel ffmpeg session. Segments are immutable once written and may be cached aggressively by intermediaries.",
	tags: ["streaming"],
	request: {
		params: z.object({
			channelId: z.string().min(1).max(128),
			segment: z
				.string()
				.min(1)
				.max(64)
				.regex(/^[A-Za-z0-9._-]+$/)
		})
	},
	responses: {
		200: {
			description: "Segment bytes.",
			content: {
				"video/mp2t": { schema: { type: "string", format: "binary" } }
			}
		},
		404: {
			description: "Segment unknown or session not active.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/recordings",
	summary: "List recordings (filtered + paginated)",
	description:
		"Returns a stable cursor-paginated set of recordings matching the supplied title, status, channel, series, and date filters. EPG artwork and episode metadata are batch-loaded for the bounded page. The response includes full-filter totals, disk size, and complete aggregates for series represented on the page. Pagination defaults to `limit=50` and is clamped to a maximum of `limit=200`.",
	tags: ["recordings"],
	request: { query: recordingListQuerySchema },
	responses: {
		200: {
			description: "Matching recordings.",
			content: { "application/json": { schema: RecordingList } }
		},
		400: {
			description: "Invalid query parameters.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "post",
	path: "/api/v1/recordings",
	summary: "Schedule a one-off recording",
	description:
		"Persists the recording row (`status=scheduled`) and arms the in-process scheduler to start the ffmpeg recording at `start - paddingBeforeSec`.",
	tags: ["recordings"],
	request: {
		body: {
			required: true,
			content: { "application/json": { schema: RecordingCreate } }
		}
	},
	responses: {
		201: {
			description: "Recording scheduled.",
			content: { "application/json": { schema: Recording } }
		},
		400: {
			description: "Invalid body.",
			content: { "application/json": { schema: ErrorResponse } }
		},
		409: {
			description: "Recording storage is not configured.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "post",
	path: "/api/v1/recordings/by-program",
	summary: "Schedule a recording for a specific EPG program",
	description:
		"Resolves the channel via the channel ↔ EPG mapping and atomically creates the recording plus scheduler job. Retrying while the program is scheduled or recording returns the same active row with `created=false`. Returns `409` with code `channel_unmapped` when no tuner channel is mapped, or `program_not_recordable` after the program ends.",
	tags: ["recordings"],
	request: {
		body: {
			required: true,
			content: { "application/json": { schema: RecordingByProgramCreate } }
		}
	},
	responses: {
		200: {
			description: "An active recording already exists for this program.",
			content: { "application/json": { schema: RecordingByProgramResponse } }
		},
		201: {
			description: "Recording scheduled.",
			content: { "application/json": { schema: RecordingByProgramResponse } }
		},
		400: {
			description: "Invalid body.",
			content: { "application/json": { schema: ErrorResponse } }
		},
		404: {
			description: "Program not found.",
			content: { "application/json": { schema: ErrorResponse } }
		},
		409: {
			description:
				"The program has ended, its EPG channel has no mapped tuner channel, or recording storage is not configured.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/recordings/{id}",
	summary: "Get a single recording (with EPG metadata)",
	description:
		"Returns the recording row plus the EPG-derived metadata (subtitle, description, season/episode, categories, artwork URL) when the recording is linked to an EPG program and that program row still exists. The `metadata` block is `null` for one-off recordings or when the originating program has been pruned.",
	tags: ["recordings"],
	request: { params: z.object({ id: z.string().uuid() }) },
	responses: {
		200: {
			description: "The recording.",
			content: { "application/json": { schema: RecordingDetail } }
		},
		404: {
			description: "Recording not found.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/recordings/{id}/artwork",
	summary: "Proxy recording artwork through the API origin",
	description:
		"Fetches the recording's EPG artwork server-side with host, content-type, response-size, timeout, and cache limits.",
	tags: ["recordings"],
	request: { params: z.object({ id: z.string().uuid() }) },
	responses: {
		200: {
			description: "Recording artwork bytes.",
			content: { "image/*": { schema: { type: "string", format: "binary" } } }
		},
		404: {
			description: "Recording or artwork not found.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/recordings/{id}/stream.m3u8",
	summary: "Prepare and return a recording HLS playlist",
	description:
		"Validates that the recording completed and its file is readable, then creates or reuses a VOD HLS window keyed by recording and start timestamp. A browser-generated viewerId owns the window across playlist and segment requests, allowing independent tabs to seek without replacing each other. Compatible H.264/AAC streams are copied; incompatible streams are selectively transcoded for browser playback.",
	tags: ["recordings"],
	request: {
		params: z.object({ id: z.string().uuid() }),
		query: z.object({
			start: z.coerce.number().int().min(0).optional().default(0),
			viewerId: z.string().uuid().optional()
		})
	},
	responses: {
		200: {
			description: "Recording HLS media playlist.",
			content: {
				"application/vnd.apple.mpegurl": {
					schema: { type: "string" }
				}
			}
		},
		404: {
			description: "Recording not found.",
			content: { "application/json": { schema: ErrorResponse } }
		},
		409: {
			description: "Recording is incomplete, failed, or cancelled.",
			content: { "application/json": { schema: ErrorResponse } }
		},
		410: {
			description: "Recording file is missing.",
			content: { "application/json": { schema: ErrorResponse } }
		},
		422: {
			description: "Recording file is unreadable or cannot be transcoded.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/recordings/{id}/segments/{segment}",
	summary: "Serve one recording playback segment",
	description:
		"Serves immutable MPEG-TS bytes from the opaque playback session referenced by the manifest. Expired or replaced session identifiers are rejected.",
	tags: ["recordings"],
	request: {
		params: z.object({
			id: z.string().uuid(),
			segment: z
				.string()
				.min(1)
				.max(64)
				.regex(/^[A-Za-z0-9_-]+\.ts$/)
		}),
		query: z.object({
			session: z.string().uuid(),
			viewerId: z.string().uuid().optional()
		})
	},
	responses: {
		200: {
			description: "Immutable MPEG-TS segment bytes.",
			content: {
				"video/mp2t": { schema: { type: "string", format: "binary" } }
			}
		},
		404: {
			description: "Segment not found.",
			content: { "application/json": { schema: ErrorResponse } }
		},
		410: {
			description: "Playback session expired.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "post",
	path: "/api/v1/recordings/{id}/viewers/{viewerId}/release",
	summary: "Release a recording-playback viewer",
	description:
		"Idempotently releases one browser player. The final viewer stops FFmpeg and removes temporary playback artifacts immediately; heartbeat timeout remains the fallback for a lost beacon.",
	tags: ["recordings"],
	request: {
		params: z.object({
			id: z.string().uuid(),
			viewerId: z.string().uuid()
		})
	},
	responses: { 204: { description: "Viewer released or already absent." } }
});

registry.registerPath({
	method: "patch",
	path: "/api/v1/recordings/{id}",
	summary: "Update library bookkeeping fields on a recording",
	description:
		"Used by the player to mark a recording watched, persist a resume position, or toggle the `manuallyProtected` flag (which exempts the row from automatic eviction).",
	tags: ["recordings"],
	request: {
		params: z.object({ id: z.string().uuid() }),
		body: {
			required: true,
			content: { "application/json": { schema: RecordingPatch } }
		}
	},
	responses: {
		200: {
			description: "Updated recording.",
			content: { "application/json": { schema: Recording } }
		},
		400: {
			description: "Invalid body.",
			content: { "application/json": { schema: ErrorResponse } }
		},
		404: {
			description: "Recording not found.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "post",
	path: "/api/v1/recordings/{id}/cancel",
	summary: "Cancel a scheduled or in-progress recording",
	description:
		"Transitions a `scheduled` recording to `cancelled`, or signals an in-progress ffmpeg recording to terminate cleanly. Idempotent for already-terminal rows.",
	tags: ["recordings"],
	request: { params: z.object({ id: z.string().uuid() }) },
	responses: {
		200: {
			description: "The (now-cancelled) recording.",
			content: { "application/json": { schema: Recording } }
		},
		404: {
			description: "Recording not found.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "delete",
	path: "/api/v1/recordings/{id}",
	summary: "Permanently delete a recording (file + row)",
	description:
		"Removes the on-disk file and the DB row. Protected recordings return `409 recording_protected` unless the user explicitly confirms deletion and the client sends `?overrideProtection=true`. Pass `?keepFile=true` to delete only the row and leave the file behind. If the recording is still scheduled or in-progress, it is cancelled before deletion so we don't tear down the row out from under an active ffmpeg process.",
	tags: ["recordings"],
	request: {
		params: z.object({ id: z.string().uuid() }),
		query: recordingDeleteQuerySchema
	},
	responses: {
		204: { description: "Deleted." },
		404: {
			description: "Recording not found.",
			content: { "application/json": { schema: ErrorResponse } }
		},
		409: {
			description:
				"Recording is protected and deletion did not explicitly override protection.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "post",
	path: "/api/v1/recordings/library/scan",
	summary: "Reconcile the recordings library against on-disk files",
	description:
		"Walks the configured recordings directory and reconciles it with the DB: clears `file_size` + flags rows whose file vanished, refreshes `file_size` for rows whose on-disk size drifted, and counts orphan files (files on disk that no row references). Files are never deleted by the scan itself.",
	tags: ["recordings"],
	responses: {
		200: {
			description: "Scan summary.",
			content: {
				"application/json": { schema: RecordingLibraryScanResult }
			}
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/recordings/conflicts",
	summary: "Recent recording conflicts",
	description:
		"Conflicts surfaced by the most recent series-rule evaluation passes. Backed by an in-memory ring buffer (clients should also subscribe to the WS `recordings` topic for real-time updates).",
	tags: ["recordings"],
	responses: {
		200: {
			description: "Recent conflicts.",
			content: { "application/json": { schema: RecordingConflictList } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/series-rules",
	summary: "List all series rules (season passes)",
	tags: ["series-rules"],
	responses: {
		200: {
			description: "All persisted series rules.",
			content: { "application/json": { schema: SeriesRuleList } }
		}
	}
});

registry.registerPath({
	method: "post",
	path: "/api/v1/series-rules",
	summary: "Create a series rule",
	description:
		"Persists a new season-pass rule. The next evaluation pass (also triggered automatically on EPG refresh) will schedule recordings for matching upcoming programs.",
	tags: ["series-rules"],
	request: {
		body: {
			required: true,
			content: { "application/json": { schema: SeriesRuleCreate } }
		}
	},
	responses: {
		201: {
			description: "Series rule created.",
			content: { "application/json": { schema: SeriesRule } }
		},
		400: {
			description: "Invalid body.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/series-rules/{id}",
	summary: "Get a single series rule",
	tags: ["series-rules"],
	request: { params: z.object({ id: z.string().uuid() }) },
	responses: {
		200: {
			description: "The series rule.",
			content: { "application/json": { schema: SeriesRule } }
		},
		404: {
			description: "Series rule not found.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "patch",
	path: "/api/v1/series-rules/{id}",
	summary: "Partially update a series rule",
	tags: ["series-rules"],
	request: {
		params: z.object({ id: z.string().uuid() }),
		body: {
			required: true,
			content: { "application/json": { schema: SeriesRulePatch } }
		}
	},
	responses: {
		200: {
			description: "Updated series rule.",
			content: { "application/json": { schema: SeriesRule } }
		},
		400: {
			description: "Invalid body.",
			content: { "application/json": { schema: ErrorResponse } }
		},
		404: {
			description: "Series rule not found.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "delete",
	path: "/api/v1/series-rules/{id}",
	summary: "Delete a series rule",
	tags: ["series-rules"],
	request: { params: z.object({ id: z.string().uuid() }) },
	responses: {
		204: { description: "Deletion accepted." },
		404: {
			description: "Series rule not found.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/search",
	summary: "Global search across channels, programs, and recordings",
	description:
		"PostgreSQL-backed global search (rrainn/SignalHaven#U10-search). Programs + linked recordings use `websearch_to_tsquery` against `epg_programs.search_tsv` (GIN-indexed); channels use `pg_trgm` similarity on name + prefix on number. Results are capped per group by `limit` (default 10, max 25) and ordered by `ts_rank_cd` / similarity.",
	tags: ["search"],
	request: { query: SearchQuery },
	responses: {
		200: {
			description: "Grouped search hits.",
			content: { "application/json": { schema: SearchResponse } }
		},
		400: {
			description: "Invalid query parameters.",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/metrics",
	summary: "Prometheus-format metrics",
	description:
		"Returns all collected metrics in Prometheus text format 0.0.4. Includes HTTP request counts/latencies, active stream sessions, active recordings, EPG refresh durations, FFmpeg process count, and DB query durations.",
	tags: ["observability"],
	responses: {
		200: {
			description:
				"Prometheus text format metrics snapshot (text/plain; version=0.0.4).",
			content: {
				"text/plain": { schema: { type: "string" } }
			}
		}
	}
});

registry.registerPath({
	method: "get",
	path: "/api/v1/debug/bundle",
	summary: "Download a diagnostics bundle (ZIP)",
	description:
		"Returns a ZIP archive containing: system-info.json (OS/Node/process details), ffmpeg-version.txt, db-stats.json (pg_stat_user_tables), metrics.txt (Prometheus snapshot), and recent.log (tail of the current log file when LOG_FILE is configured). The endpoint is **disabled by default** and must be enabled by setting `settings.observability.debugBundleEnabled = true`.",
	tags: ["observability"],
	responses: {
		200: {
			description: "Diagnostics bundle ZIP archive.",
			content: {
				"application/zip": { schema: { type: "string", format: "binary" } }
			}
		},
		404: {
			description: "Endpoint disabled (debugBundleEnabled = false).",
			content: { "application/json": { schema: ErrorResponse } }
		}
	}
});

let cachedSpec: ReturnType<OpenApiGeneratorV31["generateDocument"]> | undefined;

export function generateOpenApiDocument(): ReturnType<
	OpenApiGeneratorV31["generateDocument"]
> {
	if (cachedSpec) {
		return cachedSpec;
	}

	const generator = new OpenApiGeneratorV31(registry.definitions);
	cachedSpec = generator.generateDocument({
		openapi: "3.1.0",
		info: {
			title: "SignalHaven API",
			version: getVersion(),
			description: "SignalHaven REST API."
		},
		servers: [{ url: "/" }]
	});

	return cachedSpec;
}

export {
	ErrorResponse,
	HealthResponse,
	Settings,
	SettingsPatch,
	SystemStatus,
	SystemInfo,
	Tuner,
	TunerActivityResponse,
	TunerCreate,
	TunerDiscoveryResponse,
	TunerList,
	TunerPatch,
	TunerStatus,
	EpgSource,
	EpgSourceCreate,
	EpgSourcePatch,
	EpgSourceList,
	EpgRefreshResult,
	EpgCandidatesResponse,
	ChannelEpgMapping,
	ChannelEpgMappingPut,
	ChannelList,
	ChannelMerge,
	Recording,
	RecordingCreate,
	RecordingByProgramCreate,
	RecordingList,
	SearchQuery,
	SearchResponse
};
