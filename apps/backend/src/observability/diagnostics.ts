/**
 * Diagnostics bundle generator.
 *
 * `generateDiagnosticsBundle()` collects:
 *   - system-info.json  — Node.js / OS / process details
 *   - ffmpeg-version.txt — output of `ffmpeg -version`
 *   - db-stats.json     — pg_stat_user_tables snapshot
 *   - metrics.txt       — current Prometheus metrics snapshot
 *   - recent.log        — tail of the current rotating log file (if configured)
 *
 * and returns a ZIP archive as a Buffer.
 */

import { exec } from "node:child_process";
import { stat } from "node:fs/promises";
import * as os from "node:os";
import { promisify } from "node:util";

import type { Pool } from "pg";

import type { MetricsCollector } from "./metrics";

const execAsync = promisify(exec);

/** How many bytes to read from the tail of the log file. */
const LOG_TAIL_BYTES = 512 * 1024; // 512 KiB

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DiagnosticsBundleOptions {
	/** pg Pool used to fetch DB stats; omit to skip db-stats.json. */
	pool?: Pool | undefined;
	/** Current metrics collector; omit to skip metrics.txt. */
	metrics?: MetricsCollector | undefined;
	/**
	 * Path to the current log file produced by pino-roll.
	 * Omit if file logging is disabled.
	 */
	logFilePath?: string | undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble a diagnostics ZIP archive and return it as a Buffer.
 *
 * The archiver library is loaded lazily so tests can run without
 * a working native module.
 */
export async function generateDiagnosticsBundle(
	opts: DiagnosticsBundleOptions = {}
): Promise<Buffer> {
	// Dynamic import so that tree-shaking / lazy loading works in tests
	// that stub individual sub-functions.
	const archiver = (await import("archiver")).default;

	return new Promise<Buffer>((resolve, reject) => {
		const arc = archiver("zip", { zlib: { level: 6 } });
		const chunks: Buffer[] = [];

		arc.on("data", (chunk: Buffer) => chunks.push(chunk));
		arc.on("end", () => resolve(Buffer.concat(chunks)));
		arc.on("error", reject);
		arc.on("warning", (err: NodeJS.ErrnoException) => {
			if (err.code !== "ENOENT") reject(err);
		});

		// Kick off all async collection in parallel, then pipe into the archive.
		collectAll(opts)
			.then(
				({ systemInfo, ffmpegVersion, dbStats, metricsText, recentLog }) => {
					arc.append(Buffer.from(JSON.stringify(systemInfo, null, 2), "utf8"), {
						name: "system-info.json"
					});

					arc.append(Buffer.from(ffmpegVersion, "utf8"), {
						name: "ffmpeg-version.txt"
					});

					if (dbStats !== null) {
						arc.append(Buffer.from(JSON.stringify(dbStats, null, 2), "utf8"), {
							name: "db-stats.json"
						});
					}

					if (metricsText !== null) {
						arc.append(Buffer.from(metricsText, "utf8"), {
							name: "metrics.txt"
						});
					}

					if (recentLog !== null) {
						arc.append(recentLog, { name: "recent.log" });
					}

					arc.finalize();
				}
			)
			.catch(reject);
	});
}

// ---------------------------------------------------------------------------
// Data collectors
// ---------------------------------------------------------------------------

interface CollectedData {
	systemInfo: ReturnType<typeof collectSystemInfo>;
	ffmpegVersion: string;
	dbStats: unknown;
	metricsText: string | null;
	recentLog: Buffer | null;
}

async function collectAll(
	opts: DiagnosticsBundleOptions
): Promise<CollectedData> {
	const [ffmpegVersion, dbStats, recentLog] = await Promise.all([
		collectFfmpegVersion(),
		opts.pool ? collectDbStats(opts.pool) : Promise.resolve(null),
		opts.logFilePath
			? collectRecentLog(opts.logFilePath)
			: Promise.resolve(null)
	]);

	return {
		systemInfo: collectSystemInfo(),
		ffmpegVersion,
		dbStats,
		metricsText: opts.metrics ? opts.metrics.renderPrometheus() : null,
		recentLog
	};
}

// ---------------------------------------------------------------------------
// Individual collectors (exported for unit testing)
// ---------------------------------------------------------------------------

/** Collect host / process metadata. */
export function collectSystemInfo(): Record<string, unknown> {
	const cpus = os.cpus();
	return {
		timestamp: new Date().toISOString(),
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		uptimeSec: process.uptime(),
		os: {
			type: os.type(),
			release: os.release(),
			hostname: os.hostname(),
			loadavg: os.loadavg(),
			totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
			freeMemMb: Math.round(os.freemem() / 1024 / 1024),
			cpuCount: cpus.length,
			cpuModel: cpus[0]?.model ?? "unknown"
		},
		process: {
			pid: process.pid,
			memoryMb: {
				rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
				heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
				heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
			},
			env: {
				NODE_ENV: process.env.NODE_ENV ?? "unknown",
				LOG_LEVEL: process.env.LOG_LEVEL ?? "info"
			}
		}
	};
}

/**
 * Run `ffmpeg -version` and return its stdout.
 * Returns a human-readable error string when ffmpeg is not found.
 */
export async function collectFfmpegVersion(): Promise<string> {
	try {
		const { stdout } = await execAsync("ffmpeg -version", {
			timeout: 5_000
		});
		return stdout;
	} catch (err) {
		return `ffmpeg not found or returned an error: ${String(err)}`;
	}
}

/** Row shape returned by pg_stat_user_tables. */
interface PgTableStat {
	schemaname: string;
	tablename: string;
	n_live_tup: string;
	n_dead_tup: string;
	last_autovacuum: string | null;
	last_autoanalyze: string | null;
}

/** Collect pg_stat_user_tables snapshot. */
export async function collectDbStats(pool: Pool): Promise<unknown> {
	const result = await pool.query<PgTableStat>(`
    SELECT
      schemaname,
      relname AS tablename,
      n_live_tup::text,
      n_dead_tup::text,
      last_autovacuum::text,
      last_autoanalyze::text
    FROM pg_stat_user_tables
    ORDER BY n_live_tup DESC NULLS LAST
  `);
	return {
		tables: result.rows,
		collectedAt: new Date().toISOString()
	};
}

/** Read the last {@link LOG_TAIL_BYTES} of the log file using a stream. */
export async function collectRecentLog(
	logFilePath: string
): Promise<Buffer | null> {
	const { createReadStream } = await import("node:fs");
	try {
		const info = await stat(logFilePath);
		const size = info.size;
		if (size === 0) return Buffer.alloc(0);

		const start = Math.max(0, size - LOG_TAIL_BYTES);
		return await new Promise<Buffer>((resolve, reject) => {
			const chunks: Buffer[] = [];
			const stream = createReadStream(logFilePath, { start });
			stream.on("data", (chunk: Buffer | string) => {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			});
			stream.on("end", () => resolve(Buffer.concat(chunks)));
			stream.on("error", reject);
		});
	} catch {
		return null;
	}
}
