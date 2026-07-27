/** A channel row returned by the Lighthouse guide fixture. */
export interface LighthouseGuideChannel {
	id: string;
	number: string;
	name: string;
	logoUrl: null;
	hasMapping: boolean;
}

/** A half-hour program returned by the Lighthouse guide fixture. */
export interface LighthouseGuideProgram {
	id: string;
	channelId: string;
	start: string;
	stop: string;
	title: string;
	subtitle: null;
	description: string;
	categories: string[];
	recordingId: null;
	recordingStatus: null;
}

/** The complete guide payload returned by the Lighthouse mock backend. */
export interface LighthouseGuideGrid {
	from: string;
	to: string;
	channels: LighthouseGuideChannel[];
	programs: LighthouseGuideProgram[];
}

export const epgGridChannels: LighthouseGuideChannel[];

/** Build an overlapping-safe guide payload for the requested ISO range. */
export function buildEpgGrid(
	fromIso: string,
	toIso: string
): LighthouseGuideGrid;
