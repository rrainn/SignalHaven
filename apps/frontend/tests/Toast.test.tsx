import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";

import {
	Toast,
	ToastClose,
	ToastDescription,
	ToastProvider,
	ToastTitle,
	ToastViewport
} from "../app/_ui/Toast";
import { Button } from "../app/_ui/Button";

function ToastFixture({
	variant
}: {
	variant?: "default" | "success" | "destructive";
}) {
	const [open, setOpen] = useState(false);
	return (
		<ToastProvider duration={Infinity}>
			<Button onClick={() => setOpen(true)}>Trigger</Button>
			<Toast
				open={open}
				onOpenChange={setOpen}
				variant={variant}
				duration={Infinity}
			>
				<ToastTitle>Saved</ToastTitle>
				<ToastDescription>Your changes have been saved.</ToastDescription>
				<ToastClose aria-label="Dismiss" />
			</Toast>
			<ToastViewport label="Notifications" />
		</ToastProvider>
	);
}

describe("Toast", () => {
	it("renders inside an accessible viewport region", () => {
		render(<ToastFixture />);
		expect(
			screen.getByRole("region", { name: /notifications/i })
		).toBeInTheDocument();
	});

	it("appears with role=status when triggered (default variant)", async () => {
		const user = userEvent.setup();
		render(<ToastFixture />);

		await user.click(screen.getByRole("button", { name: /trigger/i }));

		// The toast title text is rendered inside the live region so screen
		// readers announce it. We assert the user-visible content is present
		// rather than the precise element shape (Radix renders an additional
		// hidden announce node alongside the visible toast root).
		expect(await screen.findByText("Saved")).toBeInTheDocument();
		expect(
			screen.getByText("Your changes have been saved.")
		).toBeInTheDocument();
		// Default (non-foreground) toasts use role=status — at least one such
		// live region must be present.
		expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
	});

	it("exposes a dismiss button with an accessible name and closes the toast", async () => {
		const user = userEvent.setup();
		render(<ToastFixture />);

		await user.click(screen.getByRole("button", { name: /trigger/i }));
		await screen.findByText("Saved");

		const close = screen.getByRole("button", { name: /dismiss/i });
		expect(close).toBeInTheDocument();
		await user.click(close);

		// After dismissal the toast text disappears from the live region.
		expect(screen.queryByText("Saved")).not.toBeInTheDocument();
	});
});
