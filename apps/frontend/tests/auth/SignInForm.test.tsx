import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SignInForm } from "../../app/_auth/SignInForm";
import { ApiError } from "../../lib/api-client";

const signInMock = vi.fn();

vi.mock("../../app/_auth/AuthProvider", () => ({
	useAuth: () => ({
		state: { status: "signed-out" as const },
		signIn: signInMock
	})
}));

describe("SignInForm", () => {
	beforeEach(() => {
		signInMock.mockReset();
	});

	it("keeps the username and actionable form state after rejected credentials", async () => {
		const user = userEvent.setup();
		signInMock.mockRejectedValue(new ApiError("Unauthorized", 401, null));
		render(<SignInForm />);

		const username = screen.getByLabelText(/^username$/i);
		const password = screen.getByLabelText(/^password$/i);
		await user.type(username, "viewer");
		await user.type(password, "incorrect-password");
		await user.click(screen.getByRole("button", { name: /^sign in$/i }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/username or password was not recognized/i
		);
		expect(username).toHaveValue("viewer");
		expect(password).toHaveValue("");
		expect(username).toHaveAttribute("aria-invalid", "true");
		expect(password).toHaveAccessibleDescription(
			/The username or password was not recognized/i
		);
		expect(screen.getByRole("button", { name: /^sign in$/i })).toBeEnabled();
	});
});
