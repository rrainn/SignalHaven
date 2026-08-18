"use client";

import { passwordSchema, usernameSchema } from "@signalhaven/shared";
import { useState, type FormEvent } from "react";

import { ApiError } from "../../lib/api-client";
import { Button } from "../_ui/Button";
import { Input } from "../_ui/Input";
import { Spinner } from "../_ui/Spinner";
import { useAuth } from "./AuthProvider";
import { PasswordField } from "./PasswordField";

/** Creates the one administrator allowed before authentication exists. */
export function AdminAccountForm() {
	const auth = useAuth();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const errorId = "admin-account-error";
	const usernameHelpId = "admin-username-help";

	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setError(null);
		const parsedUsername = usernameSchema.safeParse(username);
		if (!parsedUsername.success) {
			setError(parsedUsername.error.issues[0]?.message ?? "Enter a username.");
			return;
		}
		const parsedPassword = passwordSchema.safeParse(password);
		if (!parsedPassword.success) {
			setError("Use a password between 8 and 128 characters.");
			return;
		}
		if (password !== confirmation) {
			setError("The passwords do not match.");
			return;
		}

		setSubmitting(true);
		try {
			await auth.createInitialAdmin({
				username: parsedUsername.data,
				password: parsedPassword.data
			});
		} catch (failure) {
			setPassword("");
			setConfirmation("");
			if (failure instanceof ApiError && failure.status === 409) {
				setError(
					"An administrator was created in another session. Sign in to continue."
				);
				await auth.refresh();
			} else {
				setError(
					"The administrator could not be created. Check your connection and try again."
				);
			}
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<form
			noValidate
			onSubmit={(event) => void submit(event)}
			className="space-y-4"
		>
			<label className="block space-y-1.5 text-sm" htmlFor="admin-username">
				<span className="font-medium text-primary">Username</span>
				<Input
					id="admin-username"
					name="username"
					autoComplete="username"
					autoCapitalize="none"
					spellCheck={false}
					value={username}
					onChange={(event) => setUsername(event.currentTarget.value)}
					aria-invalid={error ? true : undefined}
					aria-describedby={
						error ? `${usernameHelpId} ${errorId}` : usernameHelpId
					}
					className="h-12"
					disabled={submitting}
					required
				/>
				<span
					id={usernameHelpId}
					className="block text-xs leading-5 text-secondary"
				>
					Use letters, numbers, periods, underscores, or hyphens.
				</span>
			</label>
			<PasswordField
				id="admin-password"
				name="password"
				label="Password"
				autoComplete="new-password"
				minLength={8}
				maxLength={128}
				value={password}
				onChange={(event) => setPassword(event.currentTarget.value)}
				aria-invalid={error ? true : undefined}
				aria-describedby={error ? errorId : undefined}
				disabled={submitting}
				required
			/>
			<PasswordField
				id="admin-password-confirmation"
				name="password-confirmation"
				label="Confirm password"
				autoComplete="new-password"
				minLength={8}
				maxLength={128}
				value={confirmation}
				onChange={(event) => setConfirmation(event.currentTarget.value)}
				aria-invalid={error ? true : undefined}
				aria-describedby={error ? errorId : undefined}
				disabled={submitting}
				required
			/>
			{error ? (
				<p id={errorId} role="alert" className="text-sm leading-5 text-danger">
					{error}
				</p>
			) : null}
			<Button type="submit" size="lg" block disabled={submitting}>
				{submitting ? <Spinner aria-hidden="true" /> : null}
				{submitting ? "Creating administrator…" : "Create administrator"}
			</Button>
		</form>
	);
}
