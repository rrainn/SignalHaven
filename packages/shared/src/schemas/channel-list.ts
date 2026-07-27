import "../zod-openapi-setup";

import { z } from "zod";

import { tunerKindSchema } from "./tuners";

/**
 * Schemas for the channel-centric list view consumed by the U5-channels
 * Frontend (Channels page). Distinct from the EPG **grid** schema in
 * `epg-grid.ts`: where the grid is program-oriented (channels are rows
 * for the time axis), the list is *channel*-oriented and carries the
 * fields needed to filter, group and sort channels independently of any
 * program data.
 *
 * The list is always returned in canonical `sortOrder` order. The
 * Frontend layers the user-customisable order from
 * `settings.channels.order` on top of this default.
 */
export const channelListItemSchema = z.object({
	id: z.string().uuid(),
	number: z.string(),
	name: z.string(),
	logoUrl: z.string().nullable(),
	/** Optional tvg-id (XMLTV identifier); `null` when not set. */
	tvgId: z.string().nullable(),
	/** Owning tuner — used by the UI to group / filter the list. */
	tunerId: z.string().uuid(),
	tunerName: z.string(),
	tunerKind: tunerKindSchema,
	/** Whether the channel is currently surfaced in the guide / streams. */
	enabled: z.boolean(),
	/** Canonical default sort key (server-assigned). */
	sortOrder: z.number().int(),
	/** False when the channel has no EPG mapping yet. */
	hasMapping: z.boolean()
});

export type ChannelListItem = z.infer<typeof channelListItemSchema>;

/** Response body of `GET /api/v1/channels`. */
export const channelListSchema = z.object({
	items: z.array(channelListItemSchema)
});

export type ChannelList = z.infer<typeof channelListSchema>;
