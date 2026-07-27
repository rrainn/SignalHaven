import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TunersStep } from "../../app/_onboarding/steps/TunersStep";

vi.mock("../../lib/api-client", async () => {
	const actual = await vi.importActual<typeof import("../../lib/api-client")>(
		"../../lib/api-client"
	);
	return {
		...actual,
		discoverTuners: vi.fn(),
		createTuner: vi.fn(),
		syncTunerChannels: vi.fn()
	};
});

// The WS hook is exercised in its own integration; here we stub it out to
// keep the step test deterministic and avoid opening a real socket.
vi.mock("../../lib/ws-client", () => ({
	useWebSocketEvents: () => "open"
}));

import {
	createTuner,
	discoverTuners,
	syncTunerChannels
} from "../../lib/api-client";

const discoverMock = vi.mocked(discoverTuners);
const createMock = vi.mocked(createTuner);
const syncMock = vi.mocked(syncTunerChannels);

beforeEach(() => {
	discoverMock.mockReset();
	createMock.mockReset();
	syncMock.mockReset();
	syncMock.mockResolvedValue({
		added: 12,
		updated: 0,
		removed: 0,
		missing: 0,
		total: 12
	});
});

const sampleTuner = {
	id: "11111111-1111-1111-1111-111111111111",
	kind: "hdhomerun" as const,
	name: "Sample HDHR",
	config: { host: "192.168.1.50" } as Record<string, unknown>,
	createdAt: "2024-01-01T00:00:00Z",
	updatedAt: "2024-01-01T00:00:00Z"
};

describe("TunersStep", () => {
	it("lists already-configured tuners up front", () => {
		render(
			<TunersStep
				existingTuners={[sampleTuner]}
				onTunerCreated={() => {}}
				onNext={() => {}}
				onBack={() => {}}
				onSkip={() => {}}
			/>
		);
		expect(screen.getByText(/already configured/i)).toBeInTheDocument();
		expect(screen.getByText("Sample HDHR")).toBeInTheDocument();
	});

	it("runs discovery and renders an empty state when no tuners are found", async () => {
		const user = userEvent.setup();
		discoverMock.mockResolvedValue({ results: [] });

		render(
			<TunersStep
				existingTuners={[]}
				onTunerCreated={() => {}}
				onNext={() => {}}
				onBack={() => {}}
				onSkip={() => {}}
			/>
		);

		await user.click(screen.getByRole("button", { name: /detect tuners/i }));

		await waitFor(() =>
			expect(screen.getByText(/no tuners detected/i)).toBeInTheDocument()
		);
		expect(discoverMock).toHaveBeenCalledOnce();
	});

	it("saves a discovered candidate and notifies the parent", async () => {
		const user = userEvent.setup();
		discoverMock.mockResolvedValue({
			results: [
				{
					kind: "hdhomerun",
					name: "HDHR Living Room",
					config: { host: "192.168.1.50" }
				}
			]
		});
		createMock.mockResolvedValue(sampleTuner);
		const onTunerCreated = vi.fn();

		const view = render(
			<TunersStep
				existingTuners={[]}
				onTunerCreated={onTunerCreated}
				onNext={() => {}}
				onBack={() => {}}
				onSkip={() => {}}
			/>
		);

		await user.click(screen.getByRole("button", { name: /detect tuners/i }));
		await screen.findByText("HDHR Living Room");
		await user.click(screen.getByRole("button", { name: /^add$/i }));

		await waitFor(() => {
			expect(createMock).toHaveBeenCalledWith({
				kind: "hdhomerun",
				name: "HDHR Living Room",
				config: { host: "192.168.1.50" }
			});
			expect(onTunerCreated).toHaveBeenCalledWith(sampleTuner);
			expect(syncMock).toHaveBeenCalledWith(sampleTuner.id);
		});
		// Mirror the wizard parent adding the newly persisted tuner to its state.
		view.rerender(
			<TunersStep
				existingTuners={[sampleTuner]}
				onTunerCreated={onTunerCreated}
				onNext={() => {}}
				onBack={() => {}}
				onSkip={() => {}}
			/>
		);
		expect(screen.queryByText(/^no tuners detected$/i)).not.toBeInTheDocument();
		expect(
			screen.getByText(/all detected tuners are configured/i)
		).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent(
			/12 channels imported/i
		);
	});

	it("submits the manual form for an HDHomeRun tuner", async () => {
		const user = userEvent.setup();
		createMock.mockResolvedValue(sampleTuner);
		const onTunerCreated = vi.fn();

		render(
			<TunersStep
				existingTuners={[]}
				onTunerCreated={onTunerCreated}
				onNext={() => {}}
				onBack={() => {}}
				onSkip={() => {}}
			/>
		);

		await user.click(screen.getByRole("button", { name: /add manually/i }));

		const form = screen.getByRole("form", { name: /add tuner manually/i });
		const nameInput = form.querySelector(
			'input[placeholder="My HDHomeRun"]'
		) as HTMLInputElement;
		const hostInput = form.querySelector(
			'input[placeholder="192.168.1.50"]'
		) as HTMLInputElement;

		await user.type(nameInput, "Living Room");
		await user.type(hostInput, "192.168.1.50");
		await user.click(screen.getByRole("button", { name: /save tuner/i }));

		await waitFor(() => {
			expect(createMock).toHaveBeenCalledWith({
				kind: "hdhomerun",
				name: "Living Room",
				config: { host: "192.168.1.50" }
			});
			expect(onTunerCreated).toHaveBeenCalledOnce();
		});
	});

	it("keeps a created tuner and lets the user retry a failed channel import", async () => {
		const user = userEvent.setup();
		discoverMock.mockResolvedValue({
			results: [
				{
					kind: "hdhomerun",
					name: "HDHR Living Room",
					config: { host: "192.168.1.50" }
				}
			]
		});
		createMock.mockResolvedValue(sampleTuner);
		syncMock.mockRejectedValueOnce(new Error("Tuner unavailable"));
		const onTunerCreated = vi.fn();

		render(
			<TunersStep
				existingTuners={[]}
				onTunerCreated={onTunerCreated}
				onNext={() => {}}
				onBack={() => {}}
				onSkip={() => {}}
			/>
		);

		await user.click(screen.getByRole("button", { name: /detect tuners/i }));
		await screen.findByText("HDHR Living Room");
		await user.click(screen.getByRole("button", { name: /^add$/i }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/tuner added, but its channels could not be imported/i
		);
		expect(onTunerCreated).toHaveBeenCalledWith(sampleTuner);

		await user.click(screen.getByRole("button", { name: /retry import/i }));
		await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(2));
		expect(await screen.findByRole("status")).toHaveTextContent(
			/12 channels imported/i
		);
	});

	it("surfaces a discovery error message", async () => {
		const user = userEvent.setup();
		discoverMock.mockRejectedValue(new Error("Network unreachable"));

		render(
			<TunersStep
				existingTuners={[]}
				onTunerCreated={() => {}}
				onNext={() => {}}
				onBack={() => {}}
				onSkip={() => {}}
			/>
		);

		await user.click(screen.getByRole("button", { name: /detect tuners/i }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Network unreachable"
		);
	});
});
