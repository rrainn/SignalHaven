"use client";

import { LockKeyhole } from "lucide-react";
import Link from "next/link";

import { buttonStyles } from "../_ui/Button";
import { EmptyState } from "../_ui/EmptyState";

/** Explains a role boundary without mounting the protected route component. */
export function AdminAccessDenied() {
	return (
		<EmptyState
			icon={<LockKeyhole aria-hidden="true" />}
			title="Administrator access required"
			description="System settings and diagnostics are available only to the administrator."
			action={
				<Link href="/guide" className={buttonStyles({ variant: "primary" })}>
					Return to Guide
				</Link>
			}
		/>
	);
}
