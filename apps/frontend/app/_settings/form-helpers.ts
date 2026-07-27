import type { ZodIssue } from "zod";

import { ApiError } from "../../lib/api-client";

/**
 * Format a single zod issue path + message for inline display.
 *
 * Zod 4's `path` is `PropertyKey[]` (which includes `symbol`), so we
 * stringify defensively rather than rely on the looser shape we assume
 * inside the form components.
 */
export function formatIssue(issue: ZodIssue): string {
	const path =
		issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ` : "";
	return `${path}${issue.message}`;
}

/**
 * Best-effort error message extraction for the settings forms.
 *
 * - `ApiError` with a structured `body.issues` array (zod issues from the
 *   `validate` middleware) → human-readable issue list.
 * - `ApiError` with a string-bearing body → that message.
 * - Any other Error → `.message`.
 * - Unknown → the supplied fallback.
 */
export function formatErrorMessage(err: unknown, fallback: string): string {
	if (err instanceof ApiError) {
		const body = err.body as
			| { error?: { message?: string; details?: { issues?: ZodIssue[] } } }
			| { issues?: ZodIssue[] }
			| { message?: string }
			| undefined;
		const issues =
			(body as { error?: { details?: { issues?: ZodIssue[] } } } | undefined)
				?.error?.details?.issues ??
			(body as { issues?: ZodIssue[] } | undefined)?.issues;
		if (Array.isArray(issues) && issues.length > 0) {
			return issues
				.map((i) => {
					const path = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
					return `${path}${i.message}`;
				})
				.join("; ");
		}
		const errorMsg = (body as { error?: { message?: string } } | undefined)
			?.error?.message;
		if (typeof errorMsg === "string" && errorMsg.length > 0) {
			return errorMsg;
		}
		const topMsg = (body as { message?: string } | undefined)?.message;
		if (typeof topMsg === "string" && topMsg.length > 0) return topMsg;
		return err.message;
	}
	if (err instanceof Error) return err.message;
	return fallback;
}
