import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { EpgStep } from "../../app/_onboarding/steps/EpgStep";

vi.mock("../../lib/api-client", async () => {
	const actual = await vi.importActual<typeof import("../../lib/api-client")>(
		"../../lib/api-client"
	);
	return {
		...actual,
		createEpgSource: vi.fn()
	};
});

import { createEpgSource } from "../../lib/api-client";

const createEpgSourceMock = vi.mocked(createEpgSource);

beforeEach(() => {
	createEpgSourceMock.mockReset();
});

describe("EpgStep", () => {
	it("renders an empty state when there are no existing sources", () => {
		render(
			<EpgStep
				existingSources={[]}
				onSourceCreated={() => {}}
				onNext={() => {}}
				onBack={() => {}}
				onSkip={() => {}}
			/>
		);
		expect(screen.getByText(/no guide sources yet/i)).toBeInTheDocument();
	});

	it("submits the form and notifies the parent on success", async () => {
		const user = userEvent.setup();
		const onSourceCreated = vi.fn();
		createEpgSourceMock.mockResolvedValue({
			id: "11111111-1111-1111-1111-111111111111",
			kind: "xmltv",
			name: "Test guide",
			url: "https://example.com/g.xml",
			filePath: null,
			tunerId: null,
			refreshIntervalMinutes: 720,
			timezone: null,
			enabled: true,
			lastRefreshAt: null,
			lastRefreshStatus: null,
			lastRefreshError: null,
			createdAt: "2024-01-01T00:00:00Z",
			updatedAt: "2024-01-01T00:00:00Z"
		});

		render(
			<EpgStep
				existingSources={[]}
				onSourceCreated={onSourceCreated}
				onNext={() => {}}
				onBack={() => {}}
				onSkip={() => {}}
			/>
		);

		await user.type(screen.getByLabelText(/^name$/i), "Test guide");
		await user.type(
			screen.getByLabelText(/xmltv url/i),
			"https://example.com/g.xml"
		);
		await user.click(screen.getByRole("button", { name: /add guide source/i }));

		await waitFor(() => {
			expect(createEpgSourceMock).toHaveBeenCalledOnce();
			expect(onSourceCreated).toHaveBeenCalledOnce();
		});
		expect(createEpgSourceMock).toHaveBeenCalledWith({
			name: "Test guide",
			kind: "xmltv",
			url: "https://example.com/g.xml",
			refreshIntervalMinutes: 720,
			enabled: true
		});
	});

	it("shows an inline error when the request fails", async () => {
		const user = userEvent.setup();
		createEpgSourceMock.mockRejectedValue(new Error("Network down"));

		render(
			<EpgStep
				existingSources={[]}
				onSourceCreated={() => {}}
				onNext={() => {}}
				onBack={() => {}}
				onSkip={() => {}}
			/>
		);

		await user.type(screen.getByLabelText(/^name$/i), "Test");
		await user.type(
			screen.getByLabelText(/xmltv url/i),
			"https://example.com/g.xml"
		);
		await user.click(screen.getByRole("button", { name: /add guide source/i }));

		expect(await screen.findByRole("alert")).toHaveTextContent("Network down");
	});
});
