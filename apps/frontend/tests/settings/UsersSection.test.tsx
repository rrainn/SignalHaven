import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api-client", async () => {
	const actual = await vi.importActual<typeof import("../../lib/api-client")>(
		"../../lib/api-client"
	);
	return {
		...actual,
		listUsers: vi.fn(),
		createUser: vi.fn()
	};
});

import { UsersSection } from "../../app/_settings/UsersSection";
import { ApiError, createUser, listUsers } from "../../lib/api-client";

const admin = {
	id: "00000000-0000-4000-8000-000000000001",
	username: "operator",
	role: "admin" as const
};
const standardUser = {
	id: "00000000-0000-4000-8000-000000000002",
	username: "viewer",
	role: "user" as const
};

const createUserMock = vi.mocked(createUser);
const listUsersMock = vi.mocked(listUsers);

describe("UsersSection", () => {
	beforeEach(() => {
		createUserMock.mockReset();
		listUsersMock.mockReset();
	});

	it("lists local accounts without exposing profile fields", async () => {
		listUsersMock.mockResolvedValue({ users: [admin, standardUser] });
		render(<UsersSection />);

		expect(await screen.findByText("operator")).toBeInTheDocument();
		expect(screen.getByText("viewer")).toBeInTheDocument();
		expect(screen.queryByLabelText(/email/i)).toBeNull();
	});

	it("creates a standard user and clears password fields", async () => {
		const user = userEvent.setup();
		listUsersMock.mockResolvedValue({ users: [admin] });
		createUserMock.mockResolvedValue(standardUser);
		render(<UsersSection />);
		await screen.findByText("operator");

		await user.click(screen.getByRole("button", { name: /create user/i }));
		const dialog = screen.getByRole("dialog", { name: /create user/i });
		await user.type(within(dialog).getByLabelText(/^username$/i), "viewer");
		await user.type(within(dialog).getByLabelText(/^password$/i), "secret123");
		await user.type(
			within(dialog).getByLabelText(/confirm password/i, {
				selector: "input"
			}),
			"secret123"
		);
		await user.click(within(dialog).getByRole("button", { name: /create$/i }));

		await waitFor(() =>
			expect(createUserMock).toHaveBeenCalledWith({
				username: "viewer",
				password: "secret123"
			})
		);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.getByText("viewer")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /create user/i }));
		expect(screen.getByLabelText(/^password$/i)).toHaveValue("");
		expect(screen.queryByLabelText(/role/i)).toBeNull();
	});

	it("keeps the create form actionable after a username conflict", async () => {
		const user = userEvent.setup();
		listUsersMock.mockResolvedValue({ users: [admin] });
		createUserMock.mockRejectedValue(new ApiError("Conflict", 409, null));
		render(<UsersSection />);
		await screen.findByText("operator");

		await user.click(screen.getByRole("button", { name: /create user/i }));
		await user.type(screen.getByLabelText(/^username$/i), "operator");
		await user.type(screen.getByLabelText(/^password$/i), "secret123");
		await user.type(
			screen.getByLabelText(/confirm password/i, { selector: "input" }),
			"secret123"
		);
		await user.click(screen.getByRole("button", { name: /^create$/i }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/username is already in use/i
		);
		expect(screen.getByLabelText(/^username$/i)).toHaveValue("operator");
		expect(screen.getByRole("button", { name: /^create$/i })).toBeEnabled();
	});

	it("restores focus to the create trigger when the dialog closes", async () => {
		const user = userEvent.setup();
		listUsersMock.mockResolvedValue({ users: [admin] });
		render(<UsersSection />);
		const trigger = await screen.findByRole("button", { name: /create user/i });
		await user.click(trigger);
		await user.keyboard("{Escape}");

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(trigger).toHaveFocus();
	});
});
