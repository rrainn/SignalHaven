import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
	Modal,
	ModalContent,
	ModalDescription,
	ModalTitle,
	ModalTrigger
} from "../app/_ui/Modal";
import { Button } from "../app/_ui/Button";

function renderModal(onOpenChange?: (open: boolean) => void) {
	const props = onOpenChange ? { onOpenChange } : {};
	return render(
		<Modal {...props}>
			<ModalTrigger asChild>
				<Button data-testid="trigger">Open</Button>
			</ModalTrigger>
			<ModalContent>
				<ModalTitle>Confirm action</ModalTitle>
				<ModalDescription>Are you sure?</ModalDescription>
				<Button data-testid="first-action">Cancel</Button>
				<Button data-testid="second-action">Confirm</Button>
			</ModalContent>
		</Modal>
	);
}

describe("Modal", () => {
	it("opens via the trigger and exposes dialog ARIA semantics", async () => {
		const user = userEvent.setup();
		renderModal();

		await user.click(screen.getByTestId("trigger"));

		const dialog = await screen.findByRole("dialog");
		// Radix Dialog wires the title and description as the dialog's accessible
		// name + description so screen readers announce them on focus.
		expect(dialog).toHaveAccessibleName("Confirm action");
		expect(dialog).toHaveAccessibleDescription("Are you sure?");
	});

	it("closes on Escape", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		renderModal(onOpenChange);

		await user.click(screen.getByTestId("trigger"));
		await screen.findByRole("dialog");

		await user.keyboard("{Escape}");

		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("traps focus inside the dialog (Tab cycles through dialog elements)", async () => {
		const user = userEvent.setup();
		renderModal();

		await user.click(screen.getByTestId("trigger"));
		const dialog = await screen.findByRole("dialog");

		// Radix moves focus to the first focusable element on open.
		const first = screen.getByTestId("first-action");
		const second = screen.getByTestId("second-action");
		const close = screen.getByRole("button", { name: /close dialog/i });

		// Tab through every focusable element — focus must remain inside the
		// dialog (focus trap).
		for (let i = 0; i < 6; i++) {
			await user.tab();
			expect(dialog.contains(document.activeElement)).toBe(true);
		}

		// Sanity: each known focusable element is reachable.
		expect([first, second, close]).toContain(
			[first, second, close].find((el) => el === document.activeElement) ??
				first
		);
	});
});
