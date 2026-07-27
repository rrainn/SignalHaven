import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdvancedPage } from "../../app/_advanced/AdvancedPage";
import {
	ADVANCED_MODE_STORAGE_KEY,
	AdvancedModeProvider
} from "../../app/_advanced/AdvancedModeProvider";
import {
	getExternalIp,
	listFfmpegWork,
	stopFfmpegWork
} from "../../lib/api-client";

vi.mock("../../lib/api-client", () => ({
	formatClientError: (_error: unknown, fallback: string) => fallback,
	listFfmpegWork: vi.fn(),
	getExternalIp: vi.fn(),
	stopFfmpegWork: vi.fn()
}));

const listMock = vi.mocked(listFfmpegWork);
const externalIpMock = vi.mocked(getExternalIp);
const stopMock = vi.mocked(stopFfmpegWork);

beforeEach(() => {
	localStorage.setItem(ADVANCED_MODE_STORAGE_KEY, "true");
	listMock.mockReset();
	externalIpMock.mockReset();
	stopMock.mockReset();
});

describe("AdvancedPage", () => {
	it("lists and stops active FFmpeg work", async () => {
		listMock
			.mockResolvedValueOnce({
				items: [
					{
						id: "live:channel-1",
						kind: "live-stream",
						label: "Live channel 5.1",
						state: "ready",
						startedAt: "2026-07-20T12:00:00.000Z",
						profile: "720p",
						hwaccel: "videotoolbox",
						clientCount: 1
					}
				]
			})
			.mockResolvedValue({ items: [] });
		stopMock.mockResolvedValue(undefined);
		externalIpMock.mockResolvedValue({ ip: "203.0.113.42" });
		render(
			<AdvancedModeProvider>
				<AdvancedPage />
			</AdvancedModeProvider>
		);

		expect(await screen.findByText("Live channel 5.1")).toBeInTheDocument();
		expect(await screen.findByText("203.0.113.42")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Stop" }));

		expect(stopMock).toHaveBeenCalledWith("live:channel-1");
		expect(
			await screen.findByText("No active FFmpeg work")
		).toBeInTheDocument();
	});

	it("does not repeatedly send the server address to the external lookup", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		listMock.mockResolvedValue({ items: [] });
		externalIpMock.mockResolvedValue({ ip: "203.0.113.42" });

		try {
			render(
				<AdvancedModeProvider>
					<AdvancedPage />
				</AdvancedModeProvider>
			);

			expect(await screen.findByText("203.0.113.42")).toBeInTheDocument();
			expect(externalIpMock).toHaveBeenCalledTimes(1);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(3_000);
			});
			await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
			expect(externalIpMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
