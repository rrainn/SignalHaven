import type {
	Recording,
	RecordingList,
	RecordingListItem,
	RecordingListQuery,
	RecordingListSort
} from "@signalhaven/shared";

import { RECORDINGS_PAGE_SIZE } from "./query-state";

/** In-memory server stand-in used by component fixtures and stories. */
export function buildRecordingFixturePage(
	source: Array<Recording | RecordingListItem>,
	query: Partial<RecordingListQuery>
): RecordingList {
	const search = query.search?.trim().toLowerCase();
	const from = query.from ? Date.parse(query.from) : null;
	const to = query.to ? Date.parse(query.to) : null;
	const direction = query.direction ?? "desc";
	const sort = query.sort ?? "scheduledStart";
	const filtered = source.filter((recording) => {
		if (search && !recording.title.toLowerCase().includes(search)) return false;
		if (query.status && recording.status !== query.status) return false;
		if (query.channelId && recording.channelId !== query.channelId)
			return false;
		if (query.seriesRuleId && recording.seriesRuleId !== query.seriesRuleId) {
			return false;
		}
		const scheduledStart = Date.parse(recording.scheduledStart);
		if (from !== null && scheduledStart < from) return false;
		if (to !== null && scheduledStart >= to) return false;
		return true;
	});
	filtered.sort((left, right) => {
		if (sort === "actualStart") {
			// Match PostgreSQL's explicit NULLS LAST order in both directions.
			if (left.actualStart === null && right.actualStart !== null) return 1;
			if (left.actualStart !== null && right.actualStart === null) return -1;
		}
		const leftValue = fixtureSortValue(left, sort);
		const rightValue = fixtureSortValue(right, sort);
		if (leftValue !== rightValue) {
			return direction === "asc"
				? leftValue - rightValue
				: rightValue - leftValue;
		}
		return left.id.localeCompare(right.id);
	});

	const limit = query.limit ?? RECORDINGS_PAGE_SIZE;
	const cursorOffset = query.cursor?.startsWith("fixture:")
		? Number.parseInt(query.cursor.slice("fixture:".length), 10)
		: null;
	const offset =
		cursorOffset !== null && Number.isFinite(cursorOffset)
			? cursorOffset
			: (query.offset ?? 0);
	const items = filtered.slice(offset, offset + limit).map((recording) => ({
		...recording,
		metadata: "metadata" in recording ? recording.metadata : null
	}));
	const nextOffset = offset + items.length;
	const representedSeries = new Set(
		items.flatMap((recording) =>
			recording.seriesRuleId ? [recording.seriesRuleId] : []
		)
	);
	const seriesGroups = [...representedSeries].map((seriesRuleId) => {
		const members = filtered.filter(
			(recording) => recording.seriesRuleId === seriesRuleId
		);
		return {
			seriesRuleId,
			title: members[0]?.title ?? "Series",
			recordingCount: members.length,
			totalSize: members.reduce(
				(total, recording) => total + (recording.fileSize ?? 0),
				0
			)
		};
	});
	const hasOneOff = items.some((recording) => recording.seriesRuleId === null);
	const oneOffs = hasOneOff
		? filtered.filter((recording) => recording.seriesRuleId === null)
		: [];
	return {
		items,
		total: filtered.length,
		totalSize: filtered.reduce(
			(total, recording) => total + (recording.fileSize ?? 0),
			0
		),
		limit,
		offset,
		nextCursor: nextOffset < filtered.length ? `fixture:${nextOffset}` : null,
		seriesGroups,
		oneOffGroup: hasOneOff
			? {
					recordingCount: oneOffs.length,
					totalSize: oneOffs.reduce(
						(total, recording) => total + (recording.fileSize ?? 0),
						0
					)
				}
			: null
	};
}

/** Public recording rows omit createdAt, so fixtures use scheduled time. */
function fixtureSortValue(
	recording: Recording | RecordingListItem,
	sort: RecordingListSort
): number {
	if (sort === "actualStart") {
		return recording.actualStart ? Date.parse(recording.actualStart) : 0;
	}
	return Date.parse(recording.scheduledStart);
}
