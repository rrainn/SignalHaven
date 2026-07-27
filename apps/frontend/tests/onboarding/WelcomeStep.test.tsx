import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { WelcomeStep } from "../../app/_onboarding/steps/WelcomeStep";

describe("WelcomeStep", () => {
	it("renders explanatory copy and the two primary actions", () => {
		render(<WelcomeStep onNext={() => {}} onSkip={() => {}} />);
		expect(
			screen.getByRole("button", { name: /get started/i })
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /skip setup/i })
		).toBeInTheDocument();
	});

	it("invokes onNext when 'Get started' is clicked", async () => {
		const user = userEvent.setup();
		const onNext = vi.fn();
		render(<WelcomeStep onNext={onNext} onSkip={() => {}} />);

		await user.click(screen.getByRole("button", { name: /get started/i }));
		expect(onNext).toHaveBeenCalledOnce();
	});

	it("invokes onSkip when 'Skip setup' is clicked", async () => {
		const user = userEvent.setup();
		const onSkip = vi.fn();
		render(<WelcomeStep onNext={() => {}} onSkip={onSkip} />);

		await user.click(screen.getByRole("button", { name: /skip setup/i }));
		expect(onSkip).toHaveBeenCalledOnce();
	});
});
