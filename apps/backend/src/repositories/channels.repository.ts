import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import {
	channelsSettingsSchema,
	playerSettingsSchema,
	type ChannelsSettings,
	type PlayerSettings
} from "@signalhaven/shared";

import type { DatabaseClient } from "../db/client";
import {
	channels,
	channelEpgMap,
	logicalChannelEpgMap,
	logicalChannels,
	recordings,
	seriesRules,
	settings,
	tuners
} from "../db/schema";

export type ChannelSourceStatus = "active" | "missing" | "unavailable";

export type CreateChannelInput = {
	tunerId: string;
	number: string;
	providerChannelId?: string | null;
	name: string;
	logoUrl?: string;
	tvgId?: string | null;
	enabled: boolean;
	sortOrder: number;
};

export type ChannelRecord = typeof channels.$inferSelect;
export type LogicalChannelRecord = typeof logicalChannels.$inferSelect;

/** Expected user-correctable failures for channel grouping mutations. */
export class ChannelGroupingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ChannelGroupingError";
	}
}

/** Tuner-specific source details returned with a user-facing logical channel. */
export interface LogicalChannelSourceRecord extends ChannelRecord {
	tunerName: string;
	tunerKind: string;
}

/** Complete management projection for one user-facing channel. */
export interface LogicalChannelSummary {
	channel: LogicalChannelRecord;
	sources: LogicalChannelSourceRecord[];
	mappedEpgChannelId: string | null;
}

/** Channel fields needed to render one Guide row. */
export interface GuideChannelRecord {
	id: string;
	number: string;
	name: string;
	logoUrl: string | null;
	sortOrder: number;
}

export class ChannelsRepository {
	constructor(private readonly database: DatabaseClient) {}

	async create(input: CreateChannelInput) {
		const id = randomUUID();
		const created = await this.database.transaction(async (tx) => {
			// Sharing the initial id preserves existing channel URLs and preferences.
			await tx.insert(logicalChannels).values({
				id,
				number: input.number,
				name: input.name,
				logoUrl: input.logoUrl,
				enabled: input.enabled,
				sortOrder: input.sortOrder,
				updatedAt: new Date()
			});
			const [source] = await tx
				.insert(channels)
				.values({
					id,
					logicalChannelId: id,
					tunerId: input.tunerId,
					number: input.number,
					providerChannelId: input.providerChannelId ?? null,
					name: input.name,
					logoUrl: input.logoUrl,
					tvgId: input.tvgId ?? null,
					enabled: input.enabled,
					sortOrder: input.sortOrder,
					sourceStatus: "active",
					sourcePriority: 0
				})
				.returning();
			return source;
		});

		if (!created) {
			throw new Error("Failed to create channel record");
		}

		return created;
	}

	async getById(id: string) {
		const [record] = await this.database
			.select()
			.from(channels)
			.where(eq(channels.id, id))
			.limit(1);

		return record ?? null;
	}

	/** Load a stable user-facing channel identity. */
	async getLogicalChannelById(
		id: string
	): Promise<LogicalChannelRecord | null> {
		const [record] = await this.database
			.select()
			.from(logicalChannels)
			.where(eq(logicalChannels.id, id))
			.limit(1);
		return record ?? null;
	}

	/** Ordered source candidates used for playback and recording fallback. */
	async listSourcesByLogicalChannelId(
		logicalChannelId: string
	): Promise<ChannelRecord[]> {
		return this.database
			.select()
			.from(channels)
			.where(eq(channels.logicalChannelId, logicalChannelId))
			.orderBy(asc(channels.sourcePriority), asc(channels.id));
	}

	/** Assemble logical channels, source variants, and guide selection in one read. */
	async listLogicalChannelSummaries(): Promise<LogicalChannelSummary[]> {
		const [logicalRows, sourceRows, mappingRows] = await Promise.all([
			this.database
				.select()
				.from(logicalChannels)
				.orderBy(asc(logicalChannels.sortOrder), asc(logicalChannels.id)),
			this.database
				.select({
					source: channels,
					tunerName: tuners.name,
					tunerKind: tuners.kind
				})
				.from(channels)
				.innerJoin(tuners, eq(channels.tunerId, tuners.id))
				.orderBy(asc(channels.sourcePriority), asc(channels.id)),
			this.database.select().from(logicalChannelEpgMap)
		]);
		const sourcesByLogicalId = new Map<string, LogicalChannelSourceRecord[]>();
		for (const row of sourceRows) {
			const source = {
				...row.source,
				tunerName: row.tunerName,
				tunerKind: row.tunerKind
			};
			const list = sourcesByLogicalId.get(source.logicalChannelId);
			if (list) list.push(source);
			else sourcesByLogicalId.set(source.logicalChannelId, [source]);
		}
		const mappingByLogicalId = new Map(
			mappingRows.map((row) => [row.logicalChannelId, row.epgChannelId])
		);
		return logicalRows.map((channel) => ({
			channel,
			sources: sourcesByLogicalId.get(channel.id) ?? [],
			mappedEpgChannelId: mappingByLogicalId.get(channel.id) ?? null
		}));
	}

	/** All persisted channels. Used by the EPG matcher to walk every row. */
	async list(): Promise<ChannelRecord[]> {
		return this.database.select().from(channels);
	}

	/**
	 * Enabled channels projected to the fields used by the Guide.
	 *
	 * Filtering and ordering in PostgreSQL keeps the cached snapshot compact and
	 * avoids repeating stable lineup work for every requested time window.
	 */
	async listEnabledForGrid(): Promise<GuideChannelRecord[]> {
		return this.database
			.selectDistinct({
				id: logicalChannels.id,
				number: logicalChannels.number,
				name: logicalChannels.name,
				logoUrl: logicalChannels.logoUrl,
				sortOrder: logicalChannels.sortOrder
			})
			.from(logicalChannels)
			.innerJoin(
				channels,
				and(
					eq(channels.logicalChannelId, logicalChannels.id),
					eq(channels.enabled, true),
					ne(channels.sourceStatus, "unavailable")
				)
			)
			.where(eq(logicalChannels.enabled, true))
			.orderBy(asc(logicalChannels.sortOrder));
	}

	/** All persisted channels belonging to a single tuner. */
	async listByTunerId(tunerId: string): Promise<ChannelRecord[]> {
		return this.database
			.select()
			.from(channels)
			.where(eq(channels.tunerId, tunerId));
	}

	/**
	 * Patch a channel's mutable display fields (name and/or logo URL).
	 * Returns the updated record, or `null` if no row matched.
	 */
	async update(
		id: string,
		patch: {
			number?: string;
			providerChannelId?: string | null;
			name?: string;
			logoUrl?: string | null;
			tvgId?: string | null;
			sortOrder?: number;
			sourceStatus?: ChannelSourceStatus;
			sourcePriority?: number;
			lineupMissingCount?: number;
		}
	): Promise<ChannelRecord | null> {
		const values: Partial<typeof channels.$inferInsert> = {};
		if (patch.number !== undefined) values.number = patch.number;
		if (patch.providerChannelId !== undefined) {
			values.providerChannelId = patch.providerChannelId;
		}
		if (patch.name !== undefined) values.name = patch.name;
		// Passing null intentionally removes a logo that disappeared upstream.
		if (patch.logoUrl !== undefined) values.logoUrl = patch.logoUrl;
		if (patch.tvgId !== undefined) values.tvgId = patch.tvgId;
		if (patch.sortOrder !== undefined) values.sortOrder = patch.sortOrder;
		if (patch.sourceStatus !== undefined)
			values.sourceStatus = patch.sourceStatus;
		if (patch.sourcePriority !== undefined) {
			values.sourcePriority = patch.sourcePriority;
		}
		if (patch.lineupMissingCount !== undefined) {
			values.lineupMissingCount = patch.lineupMissingCount;
		}

		if (Object.keys(values).length === 0) return null;

		return this.database.transaction(async (tx) => {
			const [current] = await tx
				.select()
				.from(channels)
				.where(eq(channels.id, id))
				.limit(1);
			if (!current) return null;

			const [updated] = await tx
				.update(channels)
				.set(values)
				.where(eq(channels.id, id))
				.returning();

			if (updated && current.sourcePriority === 0) {
				const logicalPatch: Partial<typeof logicalChannels.$inferInsert> = {
					updatedAt: new Date()
				};
				// The preferred source owns public metadata while its stable id survives moves.
				if (patch.number !== undefined) logicalPatch.number = patch.number;
				if (patch.name !== undefined) logicalPatch.name = patch.name;
				if (patch.logoUrl !== undefined) logicalPatch.logoUrl = patch.logoUrl;
				if (patch.sortOrder !== undefined)
					logicalPatch.sortOrder = patch.sortOrder;
				await tx
					.update(logicalChannels)
					.set(logicalPatch)
					.where(eq(logicalChannels.id, current.logicalChannelId));
			}

			return updated ?? null;
		});
	}

	/** Remove a channel by its UUID. No-ops when the row does not exist. */
	async deleteById(id: string): Promise<void> {
		await this.database.delete(channels).where(eq(channels.id, id));
	}

	/** Merge logical channels while preserving the chosen primary public id. */
	async mergeLogicalChannels(
		logicalChannelIds: readonly string[],
		primaryLogicalChannelId: string
	): Promise<void> {
		const ids = [...new Set(logicalChannelIds)];
		if (ids.length < 2 || !ids.includes(primaryLogicalChannelId)) {
			throw new ChannelGroupingError(
				"A merge requires at least two channels and a primary"
			);
		}
		await this.database.transaction(async (tx) => {
			const existing = await tx
				.select({ id: logicalChannels.id })
				.from(logicalChannels)
				.where(inArray(logicalChannels.id, ids))
				.orderBy(asc(logicalChannels.id))
				.for("update");
			if (existing.length !== ids.length) {
				throw new ChannelGroupingError(
					"One or more logical channels were not found"
				);
			}
			const secondaryIds = ids.filter((id) => id !== primaryLogicalChannelId);
			const groupedSources = await tx
				.select({
					id: channels.id,
					logicalChannelId: channels.logicalChannelId,
					sourcePriority: channels.sourcePriority
				})
				.from(channels)
				.where(inArray(channels.logicalChannelId, ids))
				.for("update");
			const groupRank = new Map(
				[primaryLogicalChannelId, ...secondaryIds].map((id, index) => [
					id,
					index
				])
			);
			groupedSources.sort(
				(left, right) =>
					(groupRank.get(left.logicalChannelId) ?? Number.MAX_SAFE_INTEGER) -
						(groupRank.get(right.logicalChannelId) ??
							Number.MAX_SAFE_INTEGER) ||
					left.sourcePriority - right.sourcePriority ||
					left.id.localeCompare(right.id)
			);
			const mappings = await tx
				.select()
				.from(logicalChannelEpgMap)
				.where(inArray(logicalChannelEpgMap.logicalChannelId, ids));
			const selectedMapping =
				mappings.find(
					(mapping) => mapping.logicalChannelId === primaryLogicalChannelId
				) ?? mappings[0];

			await tx
				.update(channels)
				.set({ logicalChannelId: primaryLogicalChannelId })
				.where(inArray(channels.logicalChannelId, secondaryIds));
			await tx
				.update(recordings)
				.set({ channelId: primaryLogicalChannelId })
				.where(inArray(recordings.channelId, secondaryIds));
			await tx
				.update(seriesRules)
				.set({ channelId: primaryLogicalChannelId, updatedAt: new Date() })
				.where(inArray(seriesRules.channelId, secondaryIds));

			const preferenceRows = await tx
				.select()
				.from(settings)
				.where(inArray(settings.key, ["channels", "player"]))
				.orderBy(asc(settings.key))
				.for("update");
			for (const row of preferenceRows) {
				if (row.key === "channels") {
					const parsed = channelsSettingsSchema.safeParse(row.value);
					if (parsed.success) {
						await tx
							.update(settings)
							.set({
								value: reconcileChannelPreferences(
									parsed.data,
									ids,
									primaryLogicalChannelId
								)
							})
							.where(eq(settings.key, row.key));
					}
				}
				if (row.key === "player") {
					const parsed = playerSettingsSchema.safeParse(row.value);
					if (parsed.success) {
						await tx
							.update(settings)
							.set({
								value: reconcilePlayerPreferences(
									parsed.data,
									ids,
									primaryLogicalChannelId
								)
							})
							.where(eq(settings.key, row.key));
					}
				}
			}
			await tx
				.delete(logicalChannelEpgMap)
				.where(inArray(logicalChannelEpgMap.logicalChannelId, ids));
			if (selectedMapping) {
				await tx.insert(logicalChannelEpgMap).values({
					logicalChannelId: primaryLogicalChannelId,
					epgChannelId: selectedMapping.epgChannelId,
					manual: selectedMapping.manual
				});
			}
			await tx
				.delete(logicalChannels)
				.where(inArray(logicalChannels.id, secondaryIds));

			for (const [priority, source] of groupedSources.entries()) {
				await tx
					.update(channels)
					.set({ sourcePriority: priority })
					.where(eq(channels.id, source.id));
			}
		});
	}

	/** Move one physical source into a fresh logical channel. */
	async splitSource(
		logicalChannelId: string,
		sourceChannelId: string
	): Promise<string> {
		return this.database.transaction(async (tx) => {
			const [logical] = await tx
				.select({ id: logicalChannels.id })
				.from(logicalChannels)
				.where(eq(logicalChannels.id, logicalChannelId))
				.for("update")
				.limit(1);
			if (!logical)
				throw new ChannelGroupingError("Logical channel was not found");
			const sources = await tx
				.select()
				.from(channels)
				.where(eq(channels.logicalChannelId, logicalChannelId))
				.for("update");
			const source = sources.find((row) => row.id === sourceChannelId);
			if (!source) {
				throw new ChannelGroupingError(
					"Channel source was not found in this group"
				);
			}
			if (sources.length < 2) {
				throw new ChannelGroupingError(
					"A single-source channel cannot be split"
				);
			}

			const newLogicalId = randomUUID();
			await tx.insert(logicalChannels).values({
				id: newLogicalId,
				number: source.number,
				name: source.name,
				logoUrl: source.logoUrl,
				enabled: source.enabled,
				sortOrder: source.sortOrder,
				updatedAt: new Date()
			});
			await tx
				.update(channels)
				.set({ logicalChannelId: newLogicalId, sourcePriority: 0 })
				.where(eq(channels.id, sourceChannelId));
			const remainingSources = sources
				.filter((row) => row.id !== sourceChannelId)
				.sort(
					(left, right) =>
						left.sourcePriority - right.sourcePriority ||
						left.id.localeCompare(right.id)
				);
			for (const [priority, remaining] of remainingSources.entries()) {
				await tx
					.update(channels)
					.set({ sourcePriority: priority })
					.where(eq(channels.id, remaining.id));
			}
			const [newPreferred] = remainingSources;
			if (newPreferred) {
				await tx
					.update(logicalChannels)
					.set({
						number: newPreferred.number,
						name: newPreferred.name,
						logoUrl: newPreferred.logoUrl,
						sortOrder: newPreferred.sortOrder,
						updatedAt: new Date()
					})
					.where(eq(logicalChannels.id, logicalChannelId));
			}
			const [physicalMapping] = await tx
				.select()
				.from(channelEpgMap)
				.where(eq(channelEpgMap.channelId, sourceChannelId))
				.limit(1);
			const [groupMapping] = await tx
				.select()
				.from(logicalChannelEpgMap)
				.where(eq(logicalChannelEpgMap.logicalChannelId, logicalChannelId))
				.limit(1);
			const selectedMapping = physicalMapping ?? groupMapping;
			if (selectedMapping) {
				await tx.insert(logicalChannelEpgMap).values({
					logicalChannelId: newLogicalId,
					epgChannelId: selectedMapping.epgChannelId,
					manual: selectedMapping.manual
				});
			}
			return newLogicalId;
		});
	}

	/** Promote a healthy source without mutating the logical channel identity. */
	async setPreferredSource(
		logicalChannelId: string,
		sourceChannelId: string
	): Promise<void> {
		await this.database.transaction(async (tx) => {
			const [logical] = await tx
				.select({ id: logicalChannels.id })
				.from(logicalChannels)
				.where(eq(logicalChannels.id, logicalChannelId))
				.for("update")
				.limit(1);
			if (!logical)
				throw new ChannelGroupingError("Logical channel was not found");
			const sources = await tx
				.select()
				.from(channels)
				.where(eq(channels.logicalChannelId, logicalChannelId))
				.orderBy(asc(channels.sourcePriority), asc(channels.id))
				.for("update");
			const source = sources.find(
				(candidate) => candidate.id === sourceChannelId
			);
			if (!source || source.logicalChannelId !== logicalChannelId) {
				throw new ChannelGroupingError(
					"Channel source was not found in this group"
				);
			}
			if (source.sourceStatus !== "active") {
				throw new ChannelGroupingError(
					"Only an active source can be preferred"
				);
			}
			const orderedSources = [
				source,
				...sources.filter((candidate) => candidate.id !== sourceChannelId)
			];
			for (const [priority, candidate] of orderedSources.entries()) {
				await tx
					.update(channels)
					.set({ sourcePriority: priority })
					.where(eq(channels.id, candidate.id));
			}
			await tx
				.update(logicalChannels)
				.set({
					number: source.number,
					name: source.name,
					logoUrl: source.logoUrl,
					sortOrder: source.sortOrder,
					updatedAt: new Date()
				})
				.where(eq(logicalChannels.id, logicalChannelId));
		});
	}
}

/** Collapse list preferences onto the stable identity retained by a merge. */
function reconcileChannelPreferences(
	preferences: ChannelsSettings,
	mergedIds: readonly string[],
	primaryId: string
): ChannelsSettings {
	const merged = new Set(mergedIds);
	const withoutMerged = (values: readonly string[]) =>
		values.filter((value) => !merged.has(value));
	const favorite = mergedIds.some((id) => preferences.favorites.includes(id));
	const hidden = mergedIds.every((id) => preferences.hidden.includes(id));
	const earliestOrder = preferences.order.findIndex((id) => merged.has(id));
	const order = withoutMerged(preferences.order);
	if (earliestOrder >= 0) {
		order.splice(Math.min(earliestOrder, order.length), 0, primaryId);
	}
	return {
		favorites: favorite
			? [...withoutMerged(preferences.favorites), primaryId]
			: withoutMerged(preferences.favorites),
		hidden: hidden
			? [...withoutMerged(preferences.hidden), primaryId]
			: withoutMerged(preferences.hidden),
		order
	};
}

/** Preserve a source-specific quality choice under the retained public id. */
function reconcilePlayerPreferences(
	preferences: PlayerSettings,
	mergedIds: readonly string[],
	primaryId: string
): PlayerSettings {
	const qualityByChannel = { ...preferences.qualityByChannel };
	const selectedProfile =
		qualityByChannel[primaryId] ??
		mergedIds
			.map((id) => qualityByChannel[id])
			.find((value) => value !== undefined);
	for (const id of mergedIds) delete qualityByChannel[id];
	if (selectedProfile) qualityByChannel[primaryId] = selectedProfile;
	return { ...preferences, qualityByChannel };
}
