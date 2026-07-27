import type { EpgGridChannel, EpgGridProgram } from "@signalhaven/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProgramDetailsModal } from "../../app/_guide/ProgramDetailsModal";

const channel: EpgGridChannel = {
	id: "10000000-0000-4000-8000-000000000001",
	number: "12.1",
	name: "Test Channel",
	logoUrl: null,
	hasMapping: true
};

/** Builds a program around the supplied clock so live-state behavior is clear. */
function program(start: string, stop: string): EpgGridProgram {
	return {
		id: "20000000-0000-4000-8000-000000000001",
		channelId: channel.id,
		start,
		stop,
		title: "Test Program",
		subtitle: null,
		recordingId: null,
		recordingStatus: null
	};
}

const callbacks = {
	onOpenChange: vi.fn(),
	onWatch: vi.fn(),
	onRecord: vi.fn(),
	onRecordSeries: vi.fn(),
	onCancel: vi.fn(async () => undefined)
};

describe("ProgramDetailsModal", () => {
	it("does not offer Watch for a future program", () => {
		render(
			<ProgramDetailsModal
				open
				channel={channel}
				program={program(
					"2099-01-01T01:00:00.000Z",
					"2099-01-01T02:00:00.000Z"
				)}
				details={{ description: "Program details", categories: [] }}
				now={new Date("2099-01-01T00:00:00.000Z")}
				{...callbacks}
			/>
		);

		expect(screen.queryByRole("button", { name: /^watch$/i })).toBeNull();
		expect(screen.getByRole("button", { name: /^record$/i })).toBeVisible();
	});

	it("offers Watch only while the program is live on a channel", () => {
		render(
			<ProgramDetailsModal
				open
				channel={channel}
				program={program(
					"2099-01-01T01:00:00.000Z",
					"2099-01-01T02:00:00.000Z"
				)}
				details={{ description: "Program details", categories: [] }}
				now={new Date("2099-01-01T01:30:00.000Z")}
				{...callbacks}
			/>
		);

		expect(screen.getByRole("button", { name: /^watch$/i })).toBeVisible();
	});
});
