import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DoneStep } from "../../app/_onboarding/steps/DoneStep";

describe("DoneStep", () => {
	it("invokes onFinish when the primary action is clicked", async () => {
		const user = userEvent.setup();
		let called = 0;
		render(<DoneStep onFinish={() => (called += 1)} />);

		await user.click(screen.getByRole("button", { name: /open signalhaven/i }));
		expect(called).toBe(1);
	});
});
