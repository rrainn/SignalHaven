import pino, { type Logger } from "pino";
import { pinoHttp, type HttpLogger } from "pino-http";

import { isProduction, resolveEnvironment } from "../env";

/**
 * Create a structured pino logger.
 *
 * When the `LOG_FILE` environment variable is set the logger writes to
 * **both** stdout and a rotating file managed by `pino-roll`:
 *
 *   - `LOG_FILE`           — path pattern for the log file, e.g.
 *                            `/var/log/signalhaven/signalhaven.log`.  pino-roll
 *                            appends a date suffix automatically when
 *                            `LOG_ROTATE_FREQUENCY` is set.
 *   - `LOG_ROTATE_FREQUENCY` — rotation frequency: `daily` (default) |
 *                              `hourly` | `minutely` or a size string
 *                              like `10m` / `100k`.
 *   - `LOG_MAX_FILES`      — maximum number of rotated files to keep
 *                            (default: 7).  Older files are removed.
 *
 * When `LOG_FILE` is absent all output goes to stdout only (the original
 * behaviour).
 */
export function createLogger(env: NodeJS.ProcessEnv = process.env): Logger {
	const environment = resolveEnvironment(env);
	const level = env.LOG_LEVEL ?? (environment === "test" ? "silent" : "info");

	const pinoOptions = {
		level,
		base: null,
		timestamp: pino.stdTimeFunctions.isoTime
	};

	const logFile = env.LOG_FILE;
	if (!logFile) {
		return pino(pinoOptions);
	}

	const frequency = env.LOG_ROTATE_FREQUENCY ?? "daily";
	const limit = env.LOG_MAX_FILES
		? { count: Number(env.LOG_MAX_FILES) }
		: { count: 7 };

	const transport = pino.transport({
		targets: [
			// stdout
			{ target: "pino/file", options: { destination: 1 }, level },
			// rotating file
			{
				target: "pino-roll",
				options: {
					file: logFile,
					frequency,
					limit,
					mkdir: true,
					// Emit each record as a single JSON line (pino-roll default).
					sync: false
				},
				level
			}
		]
	});

	return pino(pinoOptions, transport);
}

/**
 * Resolve the current active log file path from the environment.
 *
 * Returns the value of `LOG_FILE` when file logging is enabled, `null`
 * otherwise.  Used by the diagnostics bundle to include recent logs.
 */
export function resolveLogFilePath(
	env: NodeJS.ProcessEnv = process.env
): string | null {
	return env.LOG_FILE ?? null;
}

export function httpLogger(logger: Logger): HttpLogger {
	const environment = resolveEnvironment(process.env);

	// The request-id middleware sets `req.id` before this logger runs, so
	// pino-http picks it up automatically without a custom `genReqId`.
	return pinoHttp({
		logger,
		customLogLevel: (_req, res, err) => {
			if (err || res.statusCode >= 500) {
				return "error";
			}
			if (res.statusCode >= 400) {
				return "warn";
			}
			return isProduction(environment) ? "info" : "debug";
		},
		serializers: {
			req(req) {
				return {
					id: req.id,
					method: req.method,
					url: redactSensitiveUrl(req.url)
				};
			},
			res(res) {
				return {
					statusCode: res.statusCode
				};
			}
		}
	});
}

/** Media tickets are bearer credentials and must never enter logs or bundles. */
export function redactSensitiveUrl(value: string): string {
	try {
		const parsed = new URL(value, "http://signalhaven.local");
		if (parsed.searchParams.has("mediaTicket")) {
			parsed.searchParams.set("mediaTicket", "<redacted>");
		}
		return `${parsed.pathname}${parsed.search}`;
	} catch {
		return value.replace(/([?&]mediaTicket=)[^&]*/gi, "$1%3Credacted%3E");
	}
}
