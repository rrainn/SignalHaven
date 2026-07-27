/**
 * In-process metrics store with Prometheus text-format renderer.
 *
 * Tracks:
 *  - counters  — monotonically increasing integers (requests total, etc.)
 *  - gauges    — point-in-time values (active sessions, active recordings, …)
 *  - histograms — distribution data (duration_count + duration_sum + buckets)
 *
 * The renderer is intentionally minimal: it produces valid Prometheus
 * text format 0.0.4 output without bringing in prom-client as a
 * hard dependency.
 */

import type { NextFunction, Request, Response } from "express";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LabelSet = Record<string, string>;

interface HistogramData {
	count: number;
	sum: number;
	/** bucket upper bounds → cumulative count */
	buckets: Map<number, number>;
	les: number[];
}

interface MetricMeta {
	help: string;
	type: "counter" | "gauge" | "histogram";
	/** bucket upper bounds, only meaningful for histograms */
	les?: number[];
}

// ---------------------------------------------------------------------------
// Default bucket sets
// ---------------------------------------------------------------------------

/** Standard HTTP request duration buckets (seconds). */
export const HTTP_DURATION_BUCKETS = [
	0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10
];

/** Standard short DB query duration buckets (seconds). */
export const DB_DURATION_BUCKETS = [
	0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5
];

/** EPG refresh — expected to take several seconds. */
export const EPG_DURATION_BUCKETS = [1, 2.5, 5, 10, 30, 60, 120, 300];

// ---------------------------------------------------------------------------
// MetricsCollector
// ---------------------------------------------------------------------------

/**
 * Thread-safe (single-process) in-memory metrics store.  All mutating
 * methods are synchronous so they can be called from async code without
 * extra ceremony.
 */
export class MetricsCollector {
	private readonly meta = new Map<string, MetricMeta>();
	private readonly counters = new Map<string, number>();
	private readonly gauges = new Map<string, number>();
	private readonly histograms = new Map<string, HistogramData>();

	// ---------------------------------------------------------------------------
	// Registration
	// ---------------------------------------------------------------------------

	registerCounter(name: string, help: string): this {
		this.meta.set(name, { type: "counter", help });
		return this;
	}

	registerGauge(name: string, help: string): this {
		this.meta.set(name, { type: "gauge", help });
		return this;
	}

	registerHistogram(
		name: string,
		help: string,
		les = HTTP_DURATION_BUCKETS
	): this {
		this.meta.set(name, { type: "histogram", help, les });
		return this;
	}

	// ---------------------------------------------------------------------------
	// Mutations
	// ---------------------------------------------------------------------------

	incrementCounter(
		name: string,
		labels?: LabelSet | undefined,
		amount = 1
	): void {
		const key = metricKey(name, labels);
		this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
	}

	setGauge(name: string, value: number, labels?: LabelSet | undefined): void {
		const key = metricKey(name, labels);
		this.gauges.set(key, value);
	}

	observeHistogram(
		name: string,
		value: number,
		labels?: LabelSet | undefined
	): void {
		const meta = this.meta.get(name);
		const les = meta?.les ?? HTTP_DURATION_BUCKETS;
		const key = metricKey(name, labels);
		let data = this.histograms.get(key);
		if (!data) {
			data = {
				count: 0,
				sum: 0,
				les,
				buckets: new Map(les.map((le) => [le, 0]))
			};
			this.histograms.set(key, data);
		}
		data.count += 1;
		data.sum += value;
		for (const le of les) {
			if (value <= le) {
				data.buckets.set(le, (data.buckets.get(le) ?? 0) + 1);
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Snapshot / rendering
	// ---------------------------------------------------------------------------

	/**
	 * Read the current value of a counter (for testing).
	 * Returns 0 if the counter has never been incremented.
	 */
	getCounter(name: string, labels?: LabelSet | undefined): number {
		return this.counters.get(metricKey(name, labels)) ?? 0;
	}

	/** Read the current value of a gauge. Returns 0 if never set. */
	getGauge(name: string, labels?: LabelSet | undefined): number {
		return this.gauges.get(metricKey(name, labels)) ?? 0;
	}

	/** Read snapshot data for a histogram entry. */
	getHistogram(
		name: string,
		labels?: LabelSet | undefined
	): { count: number; sum: number } | undefined {
		const data = this.histograms.get(metricKey(name, labels));
		if (!data) return undefined;
		return { count: data.count, sum: data.sum };
	}

	/**
	 * Render the full metrics store as a Prometheus text format 0.0.4 string.
	 *
	 * Each registered metric family is emitted once with a `# HELP` and
	 * `# TYPE` header followed by all label-keyed samples.
	 */
	renderPrometheus(): string {
		const lines: string[] = [];

		for (const [baseName, meta] of this.meta) {
			lines.push(`# HELP ${baseName} ${meta.help}`);
			lines.push(`# TYPE ${baseName} ${meta.type}`);

			if (meta.type === "counter") {
				for (const [key, value] of this.counters) {
					if (metricBelongsTo(key, baseName)) {
						lines.push(`${key} ${value}`);
					}
				}
			} else if (meta.type === "gauge") {
				for (const [key, value] of this.gauges) {
					if (metricBelongsTo(key, baseName)) {
						lines.push(`${key} ${value}`);
					}
				}
			} else if (meta.type === "histogram") {
				for (const [key, data] of this.histograms) {
					if (!metricBelongsTo(key, baseName)) continue;

					// Extract the label suffix (e.g. `{method="GET",route="/health"}`)
					const labelSuffix = key.slice(baseName.length);

					// Emit bucket lines
					for (const le of data.les) {
						// Each bucket entry counts all observations whose value was ≤ le
						// (incremented for every matching le in observeHistogram), so the
						// stored value is already cumulative as required by the Prometheus
						// histogram wire format.
						const cumulativeCount = data.buckets.get(le) ?? 0;
						lines.push(
							`${baseName}_bucket${insertLe(labelSuffix, le)} ${cumulativeCount}`
						);
					}
					// +Inf bucket
					lines.push(
						`${baseName}_bucket${insertLe(labelSuffix, "+Inf")} ${data.count}`
					);
					lines.push(`${baseName}_count${labelSuffix} ${data.count}`);
					lines.push(`${baseName}_sum${labelSuffix} ${data.sum}`);
				}
			}
		}

		return lines.join("\n") + "\n";
	}

	/**
	 * Build a summary object containing raw metric counts — used by the
	 * diagnostics bundle.
	 */
	snapshot(): Record<string, unknown> {
		const out: Record<string, unknown> = {};

		for (const [key, value] of this.counters) {
			out[`counter:${key}`] = value;
		}
		for (const [key, value] of this.gauges) {
			out[`gauge:${key}`] = value;
		}
		for (const [key, data] of this.histograms) {
			out[`histogram:${key}`] = { count: data.count, sum: data.sum };
		}

		return out;
	}
}

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware that instruments every response with:
 *   - `http_requests_total{method,route,status}` counter
 *   - `http_request_duration_seconds{method,route}` histogram
 *
 * Route label falls back to the matched `req.route.path` (set by Express)
 * so the cardinality stays bounded even with dynamic path parameters.
 */
export function createMetricsMiddleware(collector: MetricsCollector) {
	return (_req: Request, res: Response, next: NextFunction): void => {
		const startNs = process.hrtime.bigint();

		res.on("finish", () => {
			const req = _req;
			const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9;
			const method = req.method.toUpperCase();
			// Express sets req.route after the handler matches; fall back to the
			// raw path so we always emit something (even for 404 responses).
			const route: string =
				(req.route as { path?: string } | undefined)?.path ?? req.path;
			const status = String(res.statusCode);

			collector.incrementCounter("http_requests_total", {
				method,
				route,
				status
			});
			collector.observeHistogram("http_request_duration_seconds", durationSec, {
				method,
				route
			});
		});

		next();
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Serialise a label set into `{k="v",...}` Prometheus notation. */
function labelSuffix(labels?: LabelSet | undefined): string {
	if (!labels) return "";
	const entries = Object.entries(labels);
	if (entries.length === 0) return "";
	return (
		"{" +
		entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",") +
		"}"
	);
}

function metricKey(name: string, labels?: LabelSet | undefined): string {
	return `${name}${labelSuffix(labels)}`;
}

/** True when a stored key (name + optional labels) belongs to a metric family. */
function metricBelongsTo(key: string, baseName: string): boolean {
	return key === baseName || key.startsWith(baseName + "{");
}

/**
 * Insert a `le` label into a label suffix string.
 *
 * e.g. `insertLe(`{method="GET"}`, 0.5)` → `{method="GET",le="0.5"}`
 *       `insertLe(``, 0.5)`              → `{le="0.5"}`
 */
function insertLe(suffix: string, le: number | string): string {
	const leStr = typeof le === "number" ? String(le) : le;
	if (!suffix) return `{le="${leStr}"}`;
	// Remove trailing `}` and append the le label.
	return `${suffix.slice(0, -1)},le="${leStr}"}`;
}

function escapeLabelValue(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n");
}
