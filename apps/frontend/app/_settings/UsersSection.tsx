"use client";

import { passwordSchema, usernameSchema, type User } from "@signalhaven/shared";
import { CircleCheck, UserPlus, Users } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import {
	ApiError,
	createUser as createUserRequest,
	listUsers
} from "../../lib/api-client";
import { Badge } from "../_ui/Badge";
import { Button } from "../_ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../_ui/Card";
import { EmptyState } from "../_ui/EmptyState";
import { Input } from "../_ui/Input";
import {
	Modal,
	ModalContent,
	ModalDescription,
	ModalFooter,
	ModalHeader,
	ModalTitle,
	ModalTrigger
} from "../_ui/Modal";
import { Spinner } from "../_ui/Spinner";
import { PasswordField } from "../_auth/PasswordField";

/** Administrator-only account list and local standard-user creation flow. */
export function UsersSection() {
	const [users, setUsers] = useState<User[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [statusMessage, setStatusMessage] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoadError(null);
		try {
			const response = await listUsers();
			setUsers(response.users);
		} catch {
			setLoadError(
				"Local accounts could not be loaded. Check the server and try again."
			);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<div className="space-y-4" data-testid="users-section">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="space-y-1">
					<h2 className="text-base font-semibold text-primary">Local users</h2>
					<p className="max-w-2xl text-sm leading-6 text-secondary">
						Create username and password accounts. Each user receives a private
						recording library and guide preferences.
					</p>
				</div>
				<CreateUserDialog
					onCreated={(created) => {
						setUsers((current) =>
							current && !current.some((user) => user.id === created.id)
								? [...current, created].sort(compareUsers)
								: current
						);
						setStatusMessage(`${created.username} can now sign in.`);
					}}
				/>
			</div>

			{statusMessage ? (
				<p
					role="status"
					className="flex items-center gap-2 text-sm text-primary"
				>
					<CircleCheck aria-hidden="true" className="h-4 w-4 text-accent" />
					{statusMessage}
				</p>
			) : null}

			{loadError ? (
				<div className="space-y-3">
					<p role="alert" className="text-sm text-danger">
						{loadError}
					</p>
					<Button variant="outline" onClick={() => void load()}>
						Try again
					</Button>
				</div>
			) : users === null ? (
				<div className="flex min-h-32 items-center justify-center">
					<Spinner label="Loading local users…" />
				</div>
			) : users.length === 0 ? (
				<EmptyState
					icon={<Users aria-hidden="true" />}
					title="No local users"
					description="Create a standard user to share this SignalHaven without sharing administrator access."
				/>
			) : (
				<Card>
					<CardHeader>
						<CardTitle>Accounts</CardTitle>
					</CardHeader>
					<CardContent className="p-0 sm:p-0">
						<ul role="list" className="divide-y divide-border">
							{users.map((user) => (
								<li
									key={user.id}
									className="flex min-h-14 items-center justify-between gap-4 px-4 py-3 sm:px-6"
								>
									<span className="min-w-0 truncate text-sm font-medium text-primary">
										{user.username}
									</span>
									<Badge variant={user.role === "admin" ? "accent" : "default"}>
										{user.role === "admin" ? "Administrator" : "User"}
									</Badge>
								</li>
							))}
						</ul>
					</CardContent>
				</Card>
			)}
		</div>
	);
}

function CreateUserDialog(props: { onCreated: (user: User) => void }) {
	const [open, setOpen] = useState(false);
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const errorId = "create-user-error";

	const clear = useCallback(() => {
		setUsername("");
		setPassword("");
		setConfirmation("");
		setSubmitting(false);
		setError(null);
	}, []);

	useEffect(() => {
		if (!open) clear();
	}, [clear, open]);

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
			const created = await createUserRequest({
				username: parsedUsername.data,
				password: parsedPassword.data
			});
			props.onCreated(created);
			setOpen(false);
		} catch (failure) {
			setError(
				failure instanceof ApiError && failure.status === 409
					? "That username is already in use. Choose another username."
					: "The user could not be created. Check the server and try again."
			);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Modal
			open={open}
			onOpenChange={(open) => {
				if (!submitting) setOpen(open);
			}}
		>
			<ModalTrigger asChild>
				<Button className="sm:shrink-0">
					<UserPlus aria-hidden="true" className="h-4 w-4" />
					Create user
				</Button>
			</ModalTrigger>
			<ModalContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
				<ModalHeader>
					<ModalTitle>Create user</ModalTitle>
					<ModalDescription>
						This account can use its own guide and recording library, but cannot
						change system settings.
					</ModalDescription>
				</ModalHeader>
				<form
					noValidate
					onSubmit={(event) => void submit(event)}
					className="space-y-4"
				>
					<label
						className="block space-y-1.5 text-sm"
						htmlFor="new-user-username"
					>
						<span className="font-medium text-primary">Username</span>
						<Input
							id="new-user-username"
							name="new-user-username"
							autoComplete="off"
							autoCapitalize="none"
							spellCheck={false}
							value={username}
							onChange={(event) => setUsername(event.currentTarget.value)}
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? errorId : undefined}
							disabled={submitting}
							required
						/>
					</label>
					<PasswordField
						id="new-user-password"
						name="new-user-password"
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
						id="new-user-password-confirmation"
						name="new-user-password-confirmation"
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
						<p
							id={errorId}
							role="alert"
							className="text-sm leading-5 text-danger"
						>
							{error}
						</p>
					) : null}
					<ModalFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setOpen(false)}
							disabled={submitting}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={submitting}>
							{submitting ? <Spinner aria-hidden="true" /> : null}
							{submitting ? "Creating…" : "Create"}
						</Button>
					</ModalFooter>
				</form>
			</ModalContent>
		</Modal>
	);
}

/** Keeps server and optimistic account rows in one predictable order. */
function compareUsers(a: User, b: User): number {
	return a.username.localeCompare(b.username, undefined, {
		sensitivity: "base"
	});
}
