"use client";

import { AuthSurface } from "../_auth/AuthSurface";
import { SignInForm } from "../_auth/SignInForm";

/** `/sign-in` remains outside the shell so no protected data can flash. */
export default function SignInPage() {
	return (
		<AuthSurface
			title="Sign in"
			description="Use a local account created by your SignalHaven administrator."
			footer="Your credentials stay on this SignalHaven server."
		>
			<SignInForm />
		</AuthSurface>
	);
}
