import type { RequestHandler } from "express";

import { HttpError } from "../http/middleware/errors";

interface AttemptWindow {
	count: number;
	resetAt: number;
}

/**
 * Bound expensive scrypt attempts per process and client address. Deployments
 * with multiple backend replicas should place an equivalent limit at the proxy.
 */
export function createAuthRateLimiter(options?: {
	limit?: number;
	windowMs?: number;
	maxEntries?: number;
	now?: () => number;
}): RequestHandler {
	const limit = options?.limit ?? 10;
	const windowMs = options?.windowMs ?? 15 * 60 * 1_000;
	const maxEntries = options?.maxEntries ?? 1_000;
	const now = options?.now ?? Date.now;
	const attempts = new Map<string, AttemptWindow>();

	return (req, res, next) => {
		const currentTime = now();
		const key = `${req.ip}:${req.path}`;
		const existing = attempts.get(key);
		const window =
			existing && existing.resetAt > currentTime
				? existing
				: { count: 0, resetAt: currentTime + windowMs };
		window.count += 1;
		attempts.set(key, window);

		if (window.count > limit) {
			const retryAfter = Math.max(
				1,
				Math.ceil((window.resetAt - currentTime) / 1_000)
			);
			res.setHeader("Retry-After", String(retryAfter));
			next(
				new HttpError(
					429,
					"rate_limited",
					"Too many authentication attempts; try again later"
				)
			);
			return;
		}

		// Opportunistic pruning keeps long-running LAN servers bounded.
		if (attempts.size > maxEntries) {
			for (const [candidate, value] of attempts) {
				if (value.resetAt <= currentTime) attempts.delete(candidate);
			}
			if (attempts.size > maxEntries) {
				const oldest = [...attempts.entries()].sort(
					(left, right) => left[1].resetAt - right[1].resetAt
				);
				for (const [candidate] of oldest) {
					if (attempts.size <= maxEntries) break;
					attempts.delete(candidate);
				}
			}
		}
		next();
	};
}
