import type { SystemInfo } from "@signalhaven/shared";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	AboutSection,
	formatServerUptime
} from "../../app/_settings/AboutSection";

const systemInfo: SystemInfo = {
	version: "2.3.4",
	gitCommit: "0123456789abcdef0123456789abcdef01234567",
	uptime: 183_845
};

describe("AboutSection", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("shows the server version, commit, and human-readable uptime", () => {
		render(<AboutSection initialInfo={systemInfo} />);

		expect(screen.getByText("2.3.4")).toBeInTheDocument();
		expect(screen.getByText(systemInfo.gitCommit)).toBeInTheDocument();
		expect(screen.getByText("2d 3h 4m")).toBeInTheDocument();
	});

	it("surfaces a load failure and retries", async () => {
		const user = userEvent.setup();
		const loadInfo = vi
			.fn<() => Promise<SystemInfo>>()
			.mockRejectedValueOnce(new Error("Server unavailable"))
			.mockResolvedValueOnce(systemInfo);

		render(<AboutSection loadInfo={loadInfo} />);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Server unavailable"
		);
		await user.click(screen.getByRole("button", { name: /try again/i }));

		expect(await screen.findByText("2.3.4")).toBeInTheDocument();
		expect(loadInfo).toHaveBeenCalledTimes(2);
	});

	it("formats short and long uptimes without unstable seconds", () => {
		expect(formatServerUptime(45)).toBe("45s");
		expect(formatServerUptime(3_661)).toBe("1h 1m");
		expect(formatServerUptime(900_061)).toBe("10d 10h 1m");
	});

	it("keeps the displayed server uptime current while the tab is open", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-25T12:00:00Z"));
		render(<AboutSection initialInfo={{ ...systemInfo, uptime: 45 }} />);

		expect(screen.getByText("45s")).toBeInTheDocument();
		act(() => {
			vi.advanceTimersByTime(15_000);
		});
		expect(screen.getByText("1m")).toBeInTheDocument();
	});

	it("aborts an in-flight request when the tab unmounts", () => {
		let requestSignal: AbortSignal | undefined;
		const loadInfo = vi.fn((signal?: AbortSignal) => {
			requestSignal = signal;
			return new Promise<SystemInfo>(() => undefined);
		});
		const { unmount } = render(<AboutSection loadInfo={loadInfo} />);

		expect(requestSignal?.aborted).toBe(false);
		unmount();
		expect(requestSignal?.aborted).toBe(true);
	});

	it("stops waiting for a server information request that times out", async () => {
		vi.useFakeTimers();
		let requestSignal: AbortSignal | undefined;
		const loadInfo = vi.fn((signal?: AbortSignal) => {
			requestSignal = signal;
			return new Promise<SystemInfo>((_resolve, reject) => {
				signal?.addEventListener("abort", () => {
					reject(new DOMException("Aborted", "AbortError"));
				});
			});
		});
		render(<AboutSection loadInfo={loadInfo} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});

		expect(requestSignal?.aborted).toBe(true);
		expect(screen.getByRole("alert")).toHaveTextContent(/took too long/i);
	});

	it("explains when source revision metadata was not embedded", () => {
		render(
			<AboutSection initialInfo={{ ...systemInfo, gitCommit: "unknown" }} />
		);

		expect(screen.getByText("Not embedded")).toBeInTheDocument();
		expect(
			screen.getByText(/development builds may omit source revision metadata/i)
		).toBeInTheDocument();
	});

	it("copies the embedded commit hash with visible confirmation", async () => {
		const user = userEvent.setup();
		const writeText = vi
			.spyOn(navigator.clipboard, "writeText")
			.mockResolvedValue();
		render(<AboutSection initialInfo={systemInfo} />);

		await user.click(screen.getByRole("button", { name: "Copy Git commit" }));

		expect(writeText).toHaveBeenCalledWith(systemInfo.gitCommit);
		expect(
			screen.getByRole("button", { name: "Git commit copied" })
		).toBeInTheDocument();
	});

	it("surfaces clipboard failures without hiding the commit", async () => {
		const user = userEvent.setup();
		vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
			new Error("Clipboard unavailable")
		);
		render(<AboutSection initialInfo={systemInfo} />);

		await user.click(screen.getByRole("button", { name: "Copy Git commit" }));

		expect(
			screen.getByRole("button", { name: "Could not copy Git commit" })
		).toBeInTheDocument();
		expect(screen.getByText(systemInfo.gitCommit)).toBeInTheDocument();
	});
});
