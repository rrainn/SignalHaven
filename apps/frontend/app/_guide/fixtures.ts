import type {
	EpgGrid,
	EpgGridChannel,
	EpgGridProgram
} from "@signalhaven/shared";

import { MS_PER_HOUR, startOfHour } from "./time";

/**
 * Deterministic fixture generator for the live guide.
 *
 * Used by:
 *   - Component tests (200 channels × 24h, asserting the DOM cell budget).
 *   - The page itself when the backend has no programs yet (dev preview).
 *
 * The seed makes runs reproducible; identical (seed, params) pairs always
 * produce the same payload.
 */

const TITLES = [
	"Morning News",
	"Tech Today",
	"Wild Earth",
	"Cooking Live",
	"Movie of the Day",
	"Sports Night",
	"Late Show",
	"World Wonders",
	"Crime Hour",
	"Comedy Half-Hour",
	"Local Weather",
	"Family Feud",
	"Quiz Champions",
	"History Files",
	"Garden Show"
];

const SUBTITLES = [
	"Episode 1",
	"Season Premiere",
	"New",
	"Live",
	"Encore",
	null,
	null,
	null
];

/** Tiny linear-congruential PRNG so tests are deterministic without deps. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return function () {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Stable, deterministic UUIDv4-shaped string from a seeded RNG. Only used
 * for fixtures — never produces real entropy and must not be used for
 * anything security-sensitive. The version (`4`) and variant (`8..b`)
 * nibbles are forced so the output passes Zod's `z.string().uuid()`.
 */
function fakeUuid(rand: () => number): string {
	const hex = "0123456789abcdef";
	const chars: string[] = [];
	for (let i = 0; i < 32; i += 1)
		chars.push(hex[Math.floor(rand() * 16)] ?? "0");
	chars[12] = "4"; // version nibble
	chars[16] = ["8", "9", "a", "b"][Math.floor(rand() * 4)] ?? "8";
	return (
		chars.slice(0, 8).join("") +
		"-" +
		chars.slice(8, 12).join("") +
		"-" +
		chars.slice(12, 16).join("") +
		"-" +
		chars.slice(16, 20).join("") +
		"-" +
		chars.slice(20, 32).join("")
	);
}

export interface BuildFixtureOptions {
	channelCount: number;
	/** Window length in hours. */
	windowHours: number;
	/** Window start; defaults to the current hour. */
	from?: Date;
	/** Seed for reproducible runs (default 1). */
	seed?: number;
}

/**
 * Build a deterministic guide payload for the given window.
 *
 * Programs are laid out per-channel back-to-back, each with a duration in
 * `{30, 60, 90, 120}` minutes; back-to-back schedules ensure every cell
 * the renderer might paint exists in the fixture.
 */
export function buildGuideFixture(opts: BuildFixtureOptions): EpgGrid {
	const seed = opts.seed ?? 1;
	const rand = mulberry32(seed);

	const from = startOfHour(opts.from ?? new Date());
	const to = new Date(from.getTime() + opts.windowHours * MS_PER_HOUR);

	const channels: EpgGridChannel[] = [];
	const programs: EpgGridProgram[] = [];

	const durationsMin = [30, 60, 60, 90, 120];

	for (let i = 0; i < opts.channelCount; i += 1) {
		const channelId = fakeUuid(rand);
		channels.push({
			id: channelId,
			number: `${100 + i}`,
			name: `Channel ${i + 1}`,
			logoUrl: null,
			hasMapping: true
		});

		let cursor = from.getTime();
		while (cursor < to.getTime()) {
			const minutes =
				durationsMin[Math.floor(rand() * durationsMin.length)] ?? 60;
			const stop = new Date(cursor + minutes * 60_000);
			const titleIndex = Math.floor(rand() * TITLES.length);
			const subtitleIndex = Math.floor(rand() * SUBTITLES.length);
			programs.push({
				id: fakeUuid(rand),
				channelId,
				start: new Date(cursor).toISOString(),
				stop: stop.toISOString(),
				title: TITLES[titleIndex] ?? "Program",
				subtitle: SUBTITLES[subtitleIndex] ?? null,
				recordingId: null,
				recordingStatus: null
			});
			cursor = stop.getTime();
		}
	}

	return {
		from: from.toISOString(),
		to: to.toISOString(),
		channels,
		programs
	};
}
