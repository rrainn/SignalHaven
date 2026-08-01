import type { Recording } from "@signalhaven/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	buildChannelLogoUrl,
	buildRecordingArtworkUrl,
	buildRecordingPlaybackReleaseUrl,
	buildRecordingPlaybackUrl,
	deleteRecording,
	listAllRecordings,
	scheduleRecordingByProgram
} from "../../lib/api-client";

describe("backend media URLs", () => {
	it("keeps provider-backed images on same-origin API routes", () => {
		expect(buildRecordingArtworkUrl("recording/id")).toBe(
			"/api/v1/recordings/recording%2Fid/artwork"
		);
		expect(buildChannelLogoUrl("channel/id")).toBe(
			"/api/v1/channels/channel%2Fid/logo"
		);
	});
});

/** Build a recording accepted by the shared runtime response schema. */
function recording(id: string): Recording {
	return {
		id,
		channelId: "00000000-0000-4000-8000-000000000aaa",
		programId: null,
		title: id,
		status: "scheduled",
		scheduledStart: "2026-01-01T00:00:00Z",
		scheduledEnd: "2026-01-01T01:00:00Z",
		actualStart: null,
		actualEnd: null,
		startReason: null,
		filePath: null,
		fileSize: null,
		durationSeconds: null,
		errorMessage: null,
		seriesRuleId: null,
		manuallyProtected: false,
		watchedAt: null,
		resumePositionSeconds: null
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("buildRecordingPlaybackUrl", () => {
	it("adds a whole-second input offset only for distant recording seeks", () => {
		expect(buildRecordingPlaybackUrl("recording/id", 1_800.9)).toBe(
			"/api/v1/recordings/recording%2Fid/stream.m3u8?start=1800"
		);
		expect(buildRecordingPlaybackUrl("recording/id", 0)).toBe(
			"/api/v1/recordings/recording%2Fid/stream.m3u8"
		);
	});

	it("carries a managed viewer through playback and release URLs", () => {
		const viewerId = "33333333-3333-4333-8333-333333333333";
		expect(buildRecordingPlaybackUrl("recording/id", 42, viewerId)).toBe(
			`/api/v1/recordings/recording%2Fid/stream.m3u8?start=42&viewerId=${viewerId}`
		);
		expect(buildRecordingPlaybackReleaseUrl("recording/id", viewerId)).toBe(
			`/api/v1/recordings/recording%2Fid/viewers/${viewerId}/release`
		);
	});
});

describe("listAllRecordings", () => {
	it("exhausts a filtered query through bounded cursor pages", async () => {
		const first = recording("11111111-1111-4111-8111-111111111111");
		const second = recording("22222222-2222-4222-8222-222222222222");
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			const isLaterPage = url.includes("cursor=next-page");
			return new Response(
				JSON.stringify({
					items: isLaterPage ? [second] : [first],
					total: 2,
					totalSize: 0,
					limit: 200,
					offset: isLaterPage ? 1 : 0,
					nextCursor: isLaterPage ? null : "next-page",
					seriesGroups: [],
					oneOffGroup: { recordingCount: 2, totalSize: 0 }
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" }
				}
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const rows = await listAllRecordings({ status: "scheduled" });

		expect(rows.map((row) => row.id)).toEqual([first.id, second.id]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("limit=200");
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("status=scheduled");
		expect(String(fetchMock.mock.calls[1]?.[0])).toContain("cursor=next-page");
	});

	it("rejects a repeated cursor instead of looping indefinitely", async () => {
		const row = recording("11111111-1111-4111-8111-111111111111");
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						items: [row],
						total: 3,
						totalSize: 0,
						limit: 200,
						offset: 0,
						nextCursor: "repeated",
						seriesGroups: [],
						oneOffGroup: { recordingCount: 3, totalSize: 0 }
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" }
					}
				)
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(listAllRecordings({ status: "scheduled" })).rejects.toThrow(
			"Recordings pagination cursor repeated"
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe("deleteRecording", () => {
	it("sends the protected-recording override only after explicit confirmation", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL) => new Response(null, { status: 204 })
		);
		vi.stubGlobal("fetch", fetchMock);

		await deleteRecording("11111111-1111-4111-8111-111111111111", {
			overrideProtection: true
		});

		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
			"overrideProtection=true"
		);
	});
});

describe("scheduleRecordingByProgram", () => {
	it("sends the selected tuner variant with a shared EPG program", async () => {
		const programId = "11111111-1111-4111-8111-111111111111";
		const channelId = "22222222-2222-4222-8222-222222222222";
		const row = {
			...recording("33333333-3333-4333-8333-333333333333"),
			programId,
			channelId
		};
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify({ recording: row, created: true }), {
					status: 201,
					headers: { "Content-Type": "application/json" }
				})
		);
		vi.stubGlobal("fetch", fetchMock);

		await scheduleRecordingByProgram({ programId, channelId });

		const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(request.body))).toEqual({ programId, channelId });
	});
});
