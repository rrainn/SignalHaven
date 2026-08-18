"use client";

import { useState, type FormEvent } from "react";

import { ApiError } from "../../lib/api-client";
import { Button } from "../_ui/Button";
import { Input } from "../_ui/Input";
import { Spinner } from "../_ui/Spinner";
import { useAuth } from "./AuthProvider";
import { PasswordField } from "./PasswordField";

/** Signs into the local server while keeping credential failures non-enumerating. */
export function SignInForm() {
	const auth = useAuth();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const errorId = "sign-in-error";

	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setError(null);
		const trimmedUsername = username.trim();
		if (!trimmedUsername || !password) {
			setError("Enter both your username and password.");
			return;
		}
		setSubmitting(true);
		try {
			await auth.signIn({ username: trimmedUsername, password });
		} catch (failure) {
			setPassword("");
			setError(signInError(failure));
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
			<label className="block space-y-1.5 text-sm" htmlFor="sign-in-username">
				<span className="font-medium text-primary">Username</span>
				<Input
					id="sign-in-username"
					name="username"
					autoComplete="username"
					autoCapitalize="none"
					spellCheck={false}
					value={username}
					onChange={(event) => setUsername(event.currentTarget.value)}
					aria-invalid={error ? true : undefined}
					aria-describedby={error ? errorId : undefined}
					className="h-12"
					disabled={submitting}
					required
				/>
			</label>
			<PasswordField
				id="sign-in-password"
				name="password"
				label="Password"
				autoComplete="current-password"
				value={password}
				onChange={(event) => setPassword(event.currentTarget.value)}
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
				{submitting ? "Signing in…" : "Sign in"}
			</Button>
		</form>
	);
}

function signInError(failure: unknown): string {
	if (failure instanceof ApiError) {
		if (failure.status === 401) {
			return "The username or password was not recognized. Try again.";
		}
		if (failure.status === 429) {
			return "Too many sign-in attempts. Wait a moment, then try again.";
		}
	}
	return "SignalHaven could not sign you in. Check your connection and try again.";
}
