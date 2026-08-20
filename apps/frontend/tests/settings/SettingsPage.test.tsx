import { settingsDefaults, type SystemInfo } from "@signalhaven/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api-client", async () => {
	const actual = await vi.importActual<typeof import("../../lib/api-client")>(
		"../../lib/api-client"
	);
	return {
		...actual,
		getSettings: vi.fn(),
		getSystemInfo: vi.fn(),
		listEpgSources: vi.fn(),
		listTuners: vi.fn()
	};
});

import { SettingsPage } from "../../app/_settings/SettingsPage";
import {
	getSettings,
	getSystemInfo,
	listEpgSources,
	listTuners
} from "../../lib/api-client";

const getSystemInfoMock = vi.mocked(getSystemInfo);
const getSettingsMock = vi.mocked(getSettings);
const listEpgSourcesMock = vi.mocked(listEpgSources);
const listTunersMock = vi.mocked(listTuners);

const systemInfo: SystemInfo = {
	version: "v2.3.4",
	gitCommit: "0123456789abcdef0123456789abcdef01234567",
	uptime: 90
};

describe("SettingsPage", () => {
	beforeEach(() => {
		getSettingsMock.mockReset();
		getSettingsMock.mockResolvedValue(settingsDefaults);
		getSystemInfoMock.mockReset();
		listEpgSourcesMock.mockReset();
		listTunersMock.mockReset();
	});

	it("keeps About available while configuration resources fail and recover", async () => {
		const user = userEvent.setup();
		getSystemInfoMock.mockResolvedValue(systemInfo);
		listTunersMock
			.mockRejectedValueOnce(new Error("Tuner service unavailable"))
			.mockResolvedValueOnce({ items: [] });
		listEpgSourcesMock
			.mockRejectedValueOnce(new Error("Guide service unavailable"))
			.mockResolvedValueOnce({ items: [] });

		render(<SettingsPage defaultTab="about" />);

		expect(await screen.findByText("v2.3.4")).toBeInTheDocument();
		expect(screen.queryByText(/guide service unavailable/i)).toBeNull();

		await waitFor(() => {
			expect(listTunersMock).toHaveBeenCalledTimes(1);
			expect(listEpgSourcesMock).toHaveBeenCalledTimes(1);
		});
		await user.click(screen.getByRole("tab", { name: "Tuners" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/service unavailable/i
		);

		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByText("No tuners configured")).toBeInTheDocument();
		expect(listTunersMock).toHaveBeenCalledTimes(2);
		expect(listEpgSourcesMock).toHaveBeenCalledTimes(2);
	});
});
