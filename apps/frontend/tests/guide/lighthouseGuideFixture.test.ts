import { describe, expect, it } from "vitest";

import { buildEpgGrid } from "../../scripts/lighthouse-guide-fixture.mjs";

describe("Lighthouse guide fixture", () => {
	it("keeps program identity stable when adjacent time ranges overlap", () => {
		const firstRange = buildEpgGrid(
			"2026-07-25T16:00:00.000Z",
			"2026-07-25T20:00:00.000Z"
		);
		const expandedRange = buildEpgGrid(
			"2026-07-25T14:00:00.000Z",
			"2026-07-25T18:00:00.000Z"
		);
		const overlappingProgram = firstRange.programs.find(
			(program) => program.start === "2026-07-25T16:00:00.000Z"
		);
		const sameProgramAfterExpansion = expandedRange.programs.find(
			(program) =>
				program.channelId === overlappingProgram?.channelId &&
				program.start === overlappingProgram.start
		);

		expect(sameProgramAfterExpansion?.id).toBe(overlappingProgram?.id);
	});
});
