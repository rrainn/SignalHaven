import type { EpgProgramDetails } from "@signalhaven/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push })
}));

import { ProgramDetailsPage } from "../../app/_guide/ProgramDetailsPage";
import { safeGuideReturnPath } from "../../app/_guide/guide-return-path";

const details: EpgProgramDetails = {
	channel: {
		id: "10000000-0000-4000-8000-000000000001",
		number: "12.1",
		name: "Test Channel",
		logoUrl: null,
		hasMapping: true
	},
	program: {
		id: "20000000-0000-4000-8000-000000000001",
		channelId: "10000000-0000-4000-8000-000000000001",
		start: "2099-01-01T01:00:00.000Z",
		stop: "2099-01-01T02:00:00.000Z",
		title: "Future Show",
		subtitle: null,
		description: "Future program details",
		categories: [],
		recordingId: "30000000-0000-4000-8000-000000000001",
		recordingStatus: "scheduled"
	}
};

describe("ProgramDetailsPage", () => {
	it("shows the server-backed scheduled state without offering live Watch", () => {
		render(
			<ProgramDetailsPage
				programId={details.program.id}
				initialDetails={details}
			/>
		);

		expect(screen.getByText("Scheduled")).toBeVisible();
		expect(
			screen.getByRole("button", { name: /cancel recording/i })
		).toBeVisible();
		expect(screen.queryByRole("button", { name: /^watch$/i })).toBeNull();
	});

	it("offers a Guide recovery action when the program was deleted", async () => {
		render(
			<ProgramDetailsPage
				programId={details.program.id}
				loadProgram={async () => {
					throw new Error("not found");
				}}
			/>
		);

		expect(await screen.findByText("Program not found")).toBeVisible();
		expect(
			screen.getByRole("button", { name: /back to guide/i })
		).toBeVisible();
	});

	it("only restores local Guide URLs", () => {
		expect(
			safeGuideReturnPath(
				"/guide?at=2099-01-01T01%3A00%3A00.000Z&channel=channel-id"
			)
		).toContain("/guide?at=");
		expect(safeGuideReturnPath("https://evil.example/guide")).toBe("/guide");
		expect(safeGuideReturnPath("/settings")).toBe("/guide");
	});
});
