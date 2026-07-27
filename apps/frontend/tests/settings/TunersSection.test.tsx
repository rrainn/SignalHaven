import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { settingsDefaults, type Tuner } from "@signalhaven/shared";

import { TunersSection } from "../../app/_settings/TunersSection";

vi.mock("../../lib/api-client", async () => {
	const actual = await vi.importActual<typeof import("../../lib/api-client")>(
		"../../lib/api-client"
	);
	return {
		...actual,
		createTuner: vi.fn(),
		deleteTuner: vi.fn(),
		discoverTuners: vi.fn(),
		updateTuner: vi.fn(),
		updateSettings: vi.fn(),
		getTunerStatus: vi.fn().mockResolvedValue({
			online: true,
			checkedAt: new Date().toISOString()
		})
	};
});

vi.mock("../../lib/ws-client", () => ({
	useWebSocketEvents: () => "open"
}));

import {
	createTuner,
	deleteTuner,
	updateSettings,
	updateTuner
} from "../../lib/api-client";

const createMock = vi.mocked(createTuner);
const deleteMock = vi.mocked(deleteTuner);
const updateMock = vi.mocked(updateTuner);
const updateSettingsMock = vi.mocked(updateSettings);

beforeEach(() => {
	createMock.mockReset();
	deleteMock.mockReset();
	updateMock.mockReset();
	updateSettingsMock.mockReset();
});

const sampleTuner: Tuner = {
	id: "11111111-1111-1111-1111-111111111111",
	kind: "hdhomerun",
	name: "Sample HDHR",
	config: { host: "192.168.1.50" },
	createdAt: "2024-01-01T00:00:00Z",
	updatedAt: "2024-01-01T00:00:00Z"
};

describe("TunersSection", () => {
	it("saves the automatic lineup refresh policy", async () => {
		const user = userEvent.setup();
		const onSettingsChanged = vi.fn();
		const next = {
			...settingsDefaults,
			lineupSync: {
				enabled: true,
				intervalHours: 12,
				removalThreshold: 4
			}
		};
		updateSettingsMock.mockResolvedValue(next);
		render(
			<TunersSection
				tuners={[]}
				onChanged={() => {}}
				settings={settingsDefaults}
				onSettingsChanged={onSettingsChanged}
			/>
		);
		expect(
			screen.queryByRole("form", { name: /automatic channel imports/i })
		).not.toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: /^automatic imports$/i })
		);
		const form = screen.getByRole("form", {
			name: /automatic channel imports/i
		});
		const interval = within(form).getByLabelText(/refresh every/i);
		const threshold = within(form).getByLabelText(/remove after/i);
		await user.clear(interval);
		await user.type(interval, "12");
		await user.clear(threshold);
		await user.type(threshold, "4");
		await user.click(
			within(form).getByRole("button", { name: /save import policy/i })
		);

		await waitFor(() => {
			expect(updateSettingsMock).toHaveBeenCalledWith({
				lineupSync: next.lineupSync
			});
			expect(onSettingsChanged).toHaveBeenCalledWith(next);
		});
	});

	it("renders the live reachability badge after status check", async () => {
		render(<TunersSection tuners={[sampleTuner]} onChanged={() => {}} />);
		expect(await screen.findByTestId("tuner-status-online")).toHaveTextContent(
			/reachable/i
		);
	});

	it("rejects an empty tuner name in the manual add form", async () => {
		const user = userEvent.setup();
		render(<TunersSection tuners={[]} onChanged={() => {}} />);
		await user.click(screen.getByRole("button", { name: /^add tuner$/i }));

		await user.type(screen.getByPlaceholderText("192.168.1.50"), "10.0.0.5");
		await user.click(screen.getByRole("button", { name: /save tuner/i }));

		expect(await screen.findByRole("alert")).toBeInTheDocument();
		expect(createMock).not.toHaveBeenCalled();
	});

	it("submits a valid HDHomeRun tuner via the manual form", async () => {
		const user = userEvent.setup();
		createMock.mockResolvedValue(sampleTuner);
		const onChanged = vi.fn();

		render(<TunersSection tuners={[]} onChanged={onChanged} />);
		await user.click(screen.getByRole("button", { name: /^add tuner$/i }));
		await user.type(
			screen.getByPlaceholderText("My HDHomeRun"),
			"Living-room HDHR"
		);
		await user.type(screen.getByPlaceholderText("192.168.1.50"), "10.0.0.5");
		await user.click(screen.getByRole("button", { name: /save tuner/i }));

		await waitFor(() => {
			expect(createMock).toHaveBeenCalledWith({
				kind: "hdhomerun",
				name: "Living-room HDHR",
				config: { host: "10.0.0.5" }
			});
			expect(onChanged).toHaveBeenCalled();
		});
	});

	it("edits a tuner's name and configuration", async () => {
		const user = userEvent.setup();
		const updatedTuner: Tuner = {
			...sampleTuner,
			name: "Living Room HDHR",
			config: { host: "10.0.0.5" }
		};
		updateMock.mockResolvedValue(updatedTuner);
		const onChanged = vi.fn();

		render(<TunersSection tuners={[sampleTuner]} onChanged={onChanged} />);
		await user.click(screen.getByRole("button", { name: /edit sample hdhr/i }));

		const editForm = screen.getByRole("form", {
			name: /edit sample hdhr/i
		});
		const nameInput = within(editForm).getByLabelText("Name");
		const hostInput = within(editForm).getByLabelText("Host or IP");
		await user.clear(nameInput);
		await user.type(nameInput, "Living Room HDHR");
		await user.clear(hostInput);
		await user.type(hostInput, "10.0.0.5");
		await user.click(within(editForm).getByRole("button", { name: /save/i }));

		await waitFor(() => {
			expect(updateMock).toHaveBeenCalledWith(sampleTuner.id, {
				name: "Living Room HDHR",
				kind: "hdhomerun",
				config: { host: "10.0.0.5" }
			});
			expect(onChanged).toHaveBeenCalled();
		});
	});

	it("edits an IPTV playlist and optional EPG URL", async () => {
		const user = userEvent.setup();
		const iptvTuner: Tuner = {
			...sampleTuner,
			kind: "iptv",
			name: "Cable channels",
			config: {
				url: "https://example.com/old.m3u",
				epgUrl: "https://example.com/old.xml"
			}
		};
		updateMock.mockResolvedValue(iptvTuner);

		render(<TunersSection tuners={[iptvTuner]} onChanged={() => {}} />);
		await user.click(
			screen.getByRole("button", { name: /edit cable channels/i })
		);

		const editForm = screen.getByRole("form", {
			name: /edit cable channels/i
		});
		const playlistInput = within(editForm).getByLabelText("Playlist URL");
		const epgInput = within(editForm).getByLabelText("EPG URL (optional)");
		expect(playlistInput).toHaveValue("https://example.com/old.m3u");
		expect(epgInput).toHaveValue("https://example.com/old.xml");

		await user.clear(playlistInput);
		await user.type(playlistInput, "https://example.com/new.m3u");
		await user.clear(epgInput);
		await user.type(epgInput, "https://example.com/new.xml");
		await user.click(
			within(editForm).getByRole("button", { name: /save changes/i })
		);

		await waitFor(() => {
			expect(updateMock).toHaveBeenCalledWith(iptvTuner.id, {
				name: "Cable channels",
				kind: "iptv",
				config: {
					url: "https://example.com/new.m3u",
					epgUrl: "https://example.com/new.xml"
				}
			});
		});
	});

	it("removes a tuner when the remove action is confirmed", async () => {
		const user = userEvent.setup();
		deleteMock.mockResolvedValue();
		const onChanged = vi.fn();
		render(<TunersSection tuners={[sampleTuner]} onChanged={onChanged} />);

		await user.click(
			screen.getByRole("button", { name: /remove sample hdhr/i })
		);
		await waitFor(() => {
			expect(deleteMock).toHaveBeenCalledWith(sampleTuner.id);
			expect(onChanged).toHaveBeenCalled();
		});
	});
});
