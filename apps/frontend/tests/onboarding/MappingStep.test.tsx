import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MappingStep } from "../../app/_onboarding/steps/MappingStep";

describe("MappingStep", () => {
	it("renders informational copy and a deep link to /channels", () => {
		render(
			<MappingStep onNext={() => {}} onBack={() => {}} onSkip={() => {}} />
		);
		expect(
			screen.getByText(/channel mapping runs automatically/i)
		).toBeInTheDocument();
		const link = screen.getByRole("link", { name: /channels/i });
		expect(link).toHaveAttribute("href", "/channels");
	});

	it("wires Back, Skip, and Continue buttons to their callbacks", async () => {
		const user = userEvent.setup();
		const onNext = vi.fn();
		const onBack = vi.fn();
		const onSkip = vi.fn();
		render(<MappingStep onNext={onNext} onBack={onBack} onSkip={onSkip} />);

		await user.click(screen.getByRole("button", { name: /back/i }));
		await user.click(screen.getByRole("button", { name: /^skip$/i }));
		await user.click(screen.getByRole("button", { name: /looks good/i }));

		expect(onBack).toHaveBeenCalledOnce();
		expect(onSkip).toHaveBeenCalledOnce();
		expect(onNext).toHaveBeenCalledOnce();
	});
});
