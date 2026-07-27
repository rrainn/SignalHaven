/**
 * Pluggable error-reporter interface.
 *
 * The default implementation is a no-op so the backend works out of the
 * box without any third-party APM tooling.  Operators who want Sentry
 * (or any other error tracker) can implement `ErrorReporter` and pass it
 * into `createApp` / `createAppWithServices` via `options.errorReporter`.
 *
 * Example – wiring Sentry via env var (in a custom entry point):
 *
 * ```ts
 * import * as Sentry from "@sentry/node";
 * import { createAppWithServices } from "./app";
 *
 * Sentry.init({ dsn: process.env.SENTRY_DSN });
 *
 * const reporter: ErrorReporter = {
 *   report(err, context) {
 *     Sentry.captureException(err, { extra: context ?? {} });
 *   }
 * };
 *
 * createAppWithServices({ errorReporter: reporter });
 * ```
 *
 * The `SENTRY_DSN` env var is intentionally *not* wired automatically here
 * so users remain in full control of which Sentry SDK version (or
 * alternative) they install.
 */

export interface ErrorReporter {
	/**
	 * Report an unexpected error to an external tracking system.
	 *
	 * @param err     - The error to report.
	 * @param context - Optional key/value bag for additional context
	 *                  (e.g. request id, user id, route).
	 */
	report(err: Error, context?: Record<string, unknown>): void;
}

/**
 * No-op reporter — errors are silently dropped.  This is the default so
 * a fresh install requires zero APM configuration.
 */
export const noopReporter: ErrorReporter = {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	report(_err: Error, _context?: Record<string, unknown>): void {
		// intentionally empty
	}
};

/**
 * Create an `ErrorReporter` from the process environment.
 *
 * Currently always returns the no-op reporter.  Users who want Sentry
 * should construct a custom reporter as shown in the module-level docs
 * rather than relying on auto-detection here — that keeps the Sentry SDK
 * entirely out of this package's dependency tree.
 */
export function createErrorReporter(
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	_env: NodeJS.ProcessEnv = process.env
): ErrorReporter {
	return noopReporter;
}
