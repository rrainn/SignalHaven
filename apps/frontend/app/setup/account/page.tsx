"use client";

import { AdminAccountForm } from "../../_auth/AdminAccountForm";
import { AuthSurface } from "../../_auth/AuthSurface";
import { useAuth } from "../../_auth/AuthProvider";

/** `/setup/account` secures both fresh and previously configured servers. */
export default function InitialAdminPage() {
	const auth = useAuth();
	const freshInstall =
		auth.state.status === "account-required" && auth.state.systemSetupRequired;
	return (
		<AuthSurface
			title="Create the administrator"
			description={
				freshInstall
					? "Secure this SignalHaven before configuring tuners, guide data, and recordings."
					: "This SignalHaven was configured before accounts were added. Create the administrator to protect it."
			}
			footer="The administrator can configure this server and create additional local users."
		>
			<AdminAccountForm />
		</AuthSurface>
	);
}
