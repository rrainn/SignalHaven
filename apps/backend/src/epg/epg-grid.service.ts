/**
 * Assembles the EPG grid (guide) payload consumed by the frontend live
 * grid view (U4-guide).
 *
 * The grid is a snapshot of every *enabled* channel together with the
 * programs that intersect a given `[from, to]` time window, and the
 * recording lifecycle state (if any) for each program.  Channels that
 * have no EPG mapping are still included — the frontend renders a
 * "No guide data" placeholder for them.
 */

import type {
	EpgGrid,
	EpgGridChannel,
	EpgGridProgram,
	EpgProgramDetails
} from "@signalhaven/shared";

import type { ChannelEpgMapRepository } from "../repositories/channel-epg-map.repository";
import type {
	ChannelsRepository,
	GuideChannelRecord
} from "../repositories/channels.repository";
import type { EpgProgramsRepository } from "../repositories/epg-programs.repository";
import type {
	GuideRecordingRecord,
	RecordingsRepository
} from "../repositories/recordings.repository";

/** Priority order when multiple recordings exist for the same program. */
const STATUS_PRIORITY: Record<string, number> = {
	recording: 0,
	scheduled: 1,
	completed: 2,
	failed: 3,
	cancelled: 4
};

export interface EpgGridServiceOptions {
	channels: ChannelsRepository;
	channelEpgMap: ChannelEpgMapRepository;
	epgPrograms: EpgProgramsRepository;
	/** Optional — when omitted, recording annotations are always `null`. */
	recordings?: RecordingsRepository | undefined;
}

interface GuideSnapshot {
	enabledChannels: GuideChannelRecord[];
	epgIdByChannelId: Map<string, string>;
	channelIdsByEpgId: Map<string, string[]>;
}

export class EpgGridService {
	private readonly channels: ChannelsRepository;
	private readonly channelEpgMap: ChannelEpgMapRepository;
	private readonly epgPrograms: EpgProgramsRepository;
	private readonly recordings: RecordingsRepository | undefined;
	private snapshotPromise: Promise<GuideSnapshot> | undefined;

	constructor(options: EpgGridServiceOptions) {
		this.channels = options.channels;
		this.channelEpgMap = options.channelEpgMap;
		this.epgPrograms = options.epgPrograms;
		this.recordings = options.recordings;
	}

	/**
	 * Drops the stable lineup snapshot after channels or mappings change.
	 *
	 * An in-flight reader may finish with its original snapshot, while every
	 * subsequent request starts a fresh load from the database.
	 */
	invalidateSnapshot(): void {
		this.snapshotPromise = undefined;
	}

	/**
	 * Build the complete grid for the given time window.
	 *
	 * @param from - Inclusive lower bound (programs with `stop > from` qualify).
	 * @param to   - Exclusive upper bound (programs with `start < to` qualify).
	 */
	async getGrid(from: Date, to: Date): Promise<EpgGrid> {
		const { enabledChannels, epgIdByChannelId, channelIdsByEpgId } =
			await this.getSnapshot();

		// Collect the distinct EPG channel IDs for mapped channels only.
		const mappedEpgIds = [
			...new Set(
				enabledChannels
					.map((c) => epgIdByChannelId.get(c.id))
					.filter((id): id is string => id !== undefined)
			)
		];

		// Fetch programs that intersect the window for those EPG channels.
		const programs = await this.epgPrograms.listInWindow(
			mappedEpgIds,
			from,
			to
		);

		// Optionally annotate each program with its recording identity and status.
		let recordingByProgramId = new Map<string, GuideRecordingRecord>();
		if (this.recordings && programs.length > 0) {
			const programIds = programs.map((p) => p.id);
			const recs = await this.recordings.listByProgramIds(programIds);
			recordingByProgramId = pickBestRecording(recs);
		}

		// Assemble the response.
		const gridChannels: EpgGridChannel[] = enabledChannels.map((c) => ({
			id: c.id,
			number: c.number,
			name: c.name,
			logoUrl: c.logoUrl ?? null,
			hasMapping: epgIdByChannelId.has(c.id)
		}));

		const gridPrograms: EpgGridProgram[] = programs.flatMap((p) => {
			const recording = recordingByProgramId.get(p.id) ?? null;
			return (channelIdsByEpgId.get(p.epgChannelId) ?? []).map((channelId) => ({
				id: p.id,
				channelId,
				start: p.start.toISOString(),
				stop: p.stop.toISOString(),
				title: p.title,
				subtitle: p.subtitle ?? null,
				recordingId: recording?.id ?? null,
				recordingStatus:
					(recording?.status as EpgGridProgram["recordingStatus"]) ?? null
			}));
		});

		return {
			from: from.toISOString(),
			to: to.toISOString(),
			channels: gridChannels,
			programs: gridPrograms
		};
	}

	/**
	 * Returns the cached lineup/mapping snapshot, coalescing concurrent cold
	 * requests onto the same two database queries.
	 */
	private getSnapshot(): Promise<GuideSnapshot> {
		if (this.snapshotPromise) {
			return this.snapshotPromise;
		}

		const pending = Promise.all([
			this.channels.listEnabledForGrid(),
			this.channelEpgMap.listForGrid()
		]).then(([enabledChannels, mappings]) => {
			// Multiple tuner variants may share one EPG channel, so the reverse
			// lookup retains every enabled channel mapped to that guide source.
			const epgIdByChannelId = new Map(
				mappings.map((mapping) => [mapping.channelId, mapping.epgChannelId])
			);
			const enabledChannelIds = new Set(
				enabledChannels.map((channel) => channel.id)
			);
			const channelIdsByEpgId = new Map<string, string[]>();
			for (const mapping of mappings) {
				if (!enabledChannelIds.has(mapping.channelId)) continue;
				const channelIds = channelIdsByEpgId.get(mapping.epgChannelId);
				if (channelIds) {
					channelIds.push(mapping.channelId);
				} else {
					channelIdsByEpgId.set(mapping.epgChannelId, [mapping.channelId]);
				}
			}
			return { enabledChannels, epgIdByChannelId, channelIdsByEpgId };
		});
		this.snapshotPromise = pending;
		void pending.catch(() => {
			// Failed loads are retryable; only clear the promise that actually failed.
			if (this.snapshotPromise === pending) {
				this.snapshotPromise = undefined;
			}
		});
		return pending;
	}

	/**
	 * Load one mapped program with the same recording annotation used by the
	 * Guide so search-driven details never show stale scheduling state.
	 */
	async getProgram(programId: string): Promise<EpgProgramDetails | null> {
		const program = await this.epgPrograms.getById(programId);
		if (!program) return null;

		const mappings = await this.channelEpgMap.list();
		const mapping = mappings.find(
			(candidate) => candidate.epgChannelId === program.epgChannelId
		);
		if (!mapping) return null;

		const channel = await this.channels.getById(mapping.channelId);
		if (!channel || !channel.enabled) return null;

		const recordings = this.recordings
			? await this.recordings.listByProgramIds([program.id])
			: [];
		const recording = pickBestRecording(recordings).get(program.id) ?? null;

		return {
			channel: {
				id: channel.id,
				number: channel.number,
				name: channel.name,
				logoUrl: channel.logoUrl ?? null,
				hasMapping: true
			},
			program: {
				id: program.id,
				channelId: channel.id,
				start: program.start.toISOString(),
				stop: program.stop.toISOString(),
				title: program.title,
				subtitle: program.subtitle ?? null,
				description: program.description ?? null,
				categories: program.categories ?? [],
				recordingId: recording?.id ?? null,
				recordingStatus:
					(recording?.status as EpgGridProgram["recordingStatus"]) ?? null
			}
		};
	}
}

/**
 * For each program that has one or more recordings, pick the single most
 * informative row. The priority order is: recording > scheduled > completed >
 * failed > cancelled.
 */
function pickBestRecording(
	rows: GuideRecordingRecord[]
): Map<string, GuideRecordingRecord> {
	const best = new Map<string, GuideRecordingRecord>();
	for (const rec of rows) {
		if (!rec.programId) continue;
		const existing = best.get(rec.programId);
		if (!existing) {
			best.set(rec.programId, rec);
			continue;
		}
		const currentPriority = STATUS_PRIORITY[rec.status] ?? 99;
		const existingPriority = STATUS_PRIORITY[existing.status] ?? 99;
		if (currentPriority < existingPriority) {
			best.set(rec.programId, rec);
		}
	}
	return best;
}
