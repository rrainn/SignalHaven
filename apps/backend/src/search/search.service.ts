import {
	SEARCH_DEFAULT_LIMIT,
	SEARCH_MAX_LIMIT,
	type SearchResponse
} from "@signalhaven/shared";

import type { SearchRepository } from "../repositories/search.repository";

/**
 * Coordinates the three repository queries that back
 * `GET /api/v1/search` and shapes the rows into the public
 * `SearchResponse`.
 */
export class SearchService {
	constructor(private readonly repository: SearchRepository) {}

	async search(
		input: { q: string; limit?: number },
		userId = "00000000-0000-4000-8000-000000000001"
	): Promise<SearchResponse> {
		const q = input.q.trim();
		const limit = clampLimit(input.limit);

		if (q.length === 0) {
			return { q, channels: [], programs: [], recordings: [] };
		}

		const now = new Date();
		const [channels, programs, recordings] = await Promise.all([
			this.repository.searchChannels(q, limit),
			this.repository.searchPrograms(q, limit, now),
			this.repository.searchRecordings(q, limit, userId)
		]);

		return {
			q,
			channels: channels.map((row) => ({
				kind: "channel" as const,
				id: row.id,
				number: row.number,
				name: row.name,
				logoUrl: row.logoUrl ? `/api/v1/channels/${row.id}/logo` : null,
				score: Number(row.score)
			})),
			programs: programs.map((row) => ({
				kind: "program" as const,
				id: row.id,
				title: row.title,
				subtitle: row.subtitle ?? null,
				start: toIso(row.start),
				stop: toIso(row.stop),
				channelId: row.channelId ?? null,
				channelName: row.channelName ?? null,
				channelNumber: row.channelNumber ?? null,
				score: Number(row.score)
			})),
			recordings: recordings.map((row) => ({
				kind: "recording" as const,
				id: row.id,
				title: row.title,
				status: row.status,
				scheduledStart: toIso(row.scheduledStart),
				channelId: row.channelId,
				channelName: row.channelName ?? null,
				channelNumber: row.channelNumber ?? null,
				programId: row.programId ?? null,
				score: Number(row.score)
			}))
		};
	}
}

function clampLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) {
		return SEARCH_DEFAULT_LIMIT;
	}
	const rounded = Math.floor(limit);
	if (rounded < 1) return 1;
	if (rounded > SEARCH_MAX_LIMIT) return SEARCH_MAX_LIMIT;
	return rounded;
}

function toIso(value: Date | string): string {
	if (value instanceof Date) return value.toISOString();
	// The pg driver normally returns a Date for `timestamptz`, but raw
	// queries can occasionally hand us a string depending on the type
	// parser configuration. Normalise either shape.
	return new Date(value).toISOString();
}
