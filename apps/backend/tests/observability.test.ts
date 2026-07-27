/**
 * Unit tests for MetricsCollector and the diagnostics bundle generator.
 *
 * These tests intentionally avoid any network I/O and live DB; they
 * exercise the metrics data structures and the bundle assembly logic with
 * in-memory stubs.
 */

import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";

import {
	MetricsCollector,
	HTTP_DURATION_BUCKETS,
	EPG_DURATION_BUCKETS,
	DB_DURATION_BUCKETS,
	createMetricsMiddleware
} from "../src/observability/metrics";

import {
	collectSystemInfo,
	collectDbStats,
	collectRecentLog,
	generateDiagnosticsBundle
} from "../src/observability/diagnostics";

import {
	noopReporter,
	createErrorReporter
} from "../src/observability/error-reporter";

// ---------------------------------------------------------------------------
// MetricsCollector — counters
// ---------------------------------------------------------------------------

describe("MetricsCollector – counters", () => {
	test("starts at zero and increments", () => {
		const c = new MetricsCollector().registerCounter("hits", "Total hits");
		assert.equal(c.getCounter("hits"), 0);
		c.incrementCounter("hits");
		c.incrementCounter("hits");
		assert.equal(c.getCounter("hits"), 2);
	});

	test("increments with custom amount", () => {
		const c = new MetricsCollector().registerCounter(
			"bytes",
			"Bytes transferred"
		);
		c.incrementCounter("bytes", undefined, 1024);
		assert.equal(c.getCounter("bytes"), 1024);
	});

	test("supports label partitioning", () => {
		const c = new MetricsCollector().registerCounter(
			"http_requests_total",
			"HTTP requests"
		);
		c.incrementCounter("http_requests_total", { method: "GET", status: "200" });
		c.incrementCounter("http_requests_total", {
			method: "POST",
			status: "201"
		});
		c.incrementCounter("http_requests_total", { method: "GET", status: "200" });

		assert.equal(
			c.getCounter("http_requests_total", { method: "GET", status: "200" }),
			2
		);
		assert.equal(
			c.getCounter("http_requests_total", { method: "POST", status: "201" }),
			1
		);
		// Unknown label combo should be zero.
		assert.equal(
			c.getCounter("http_requests_total", { method: "DELETE", status: "204" }),
			0
		);
	});

	test("Prometheus text includes HELP, TYPE and sample lines", () => {
		const c = new MetricsCollector().registerCounter(
			"page_views_total",
			"Page views"
		);
		c.incrementCounter("page_views_total", { page: "/home" }, 5);

		const text = c.renderPrometheus();
		assert.ok(text.includes("# HELP page_views_total Page views"));
		assert.ok(text.includes("# TYPE page_views_total counter"));
		assert.ok(text.includes('page_views_total{page="/home"} 5'));
	});
});

// ---------------------------------------------------------------------------
// MetricsCollector — gauges
// ---------------------------------------------------------------------------

describe("MetricsCollector – gauges", () => {
	test("set and read a gauge value", () => {
		const c = new MetricsCollector().registerGauge(
			"stream_sessions_active",
			"Active sessions"
		);
		c.setGauge("stream_sessions_active", 3);
		assert.equal(c.getGauge("stream_sessions_active"), 3);
		c.setGauge("stream_sessions_active", 1);
		assert.equal(c.getGauge("stream_sessions_active"), 1);
	});

	test("supports labels", () => {
		const c = new MetricsCollector().registerGauge(
			"ffmpeg_processes_total",
			"FFmpeg processes"
		);
		c.setGauge("ffmpeg_processes_total", 2, { kind: "live" });
		c.setGauge("ffmpeg_processes_total", 1, { kind: "recording" });

		assert.equal(c.getGauge("ffmpeg_processes_total", { kind: "live" }), 2);
		assert.equal(
			c.getGauge("ffmpeg_processes_total", { kind: "recording" }),
			1
		);
	});

	test("Prometheus text includes HELP, TYPE and sample lines", () => {
		const c = new MetricsCollector().registerGauge(
			"recordings_active",
			"Active recordings"
		);
		c.setGauge("recordings_active", 7);

		const text = c.renderPrometheus();
		assert.ok(text.includes("# HELP recordings_active Active recordings"));
		assert.ok(text.includes("# TYPE recordings_active gauge"));
		assert.ok(text.includes("recordings_active 7"));
	});
});

// ---------------------------------------------------------------------------
// MetricsCollector — histograms
// ---------------------------------------------------------------------------

describe("MetricsCollector – histograms", () => {
	test("records count and sum", () => {
		const c = new MetricsCollector().registerHistogram(
			"http_request_duration_seconds",
			"HTTP duration",
			HTTP_DURATION_BUCKETS
		);
		c.observeHistogram("http_request_duration_seconds", 0.05);
		c.observeHistogram("http_request_duration_seconds", 0.2);

		const snap = c.getHistogram("http_request_duration_seconds");
		assert.ok(snap);
		assert.equal(snap.count, 2);
		assert.ok(Math.abs(snap.sum - 0.25) < 1e-9);
	});

	test("Prometheus text includes bucket lines", () => {
		const c = new MetricsCollector().registerHistogram(
			"db_query_duration_seconds",
			"DB query duration",
			DB_DURATION_BUCKETS
		);
		c.observeHistogram("db_query_duration_seconds", 0.003);

		const text = c.renderPrometheus();
		assert.ok(text.includes("# TYPE db_query_duration_seconds histogram"));
		// The value 0.003 is ≤ 0.005, 0.01, 0.025, … so those buckets should = 1
		assert.ok(text.includes('db_query_duration_seconds_bucket{le="0.005"} 1'));
		assert.ok(text.includes('db_query_duration_seconds_bucket{le="+Inf"} 1'));
		assert.ok(text.includes("db_query_duration_seconds_count 1"));
	});

	test("cumulative bucket counts are correct", () => {
		const les = [0.1, 0.5, 1.0];
		const c = new MetricsCollector().registerHistogram("dur", "Duration", les);
		// 0.05 → bucket[0.1]=1, bucket[0.5]=1, bucket[1.0]=1
		// 0.3  → bucket[0.5]=1, bucket[1.0]=1
		// 2.0  → no finite bucket
		c.observeHistogram("dur", 0.05);
		c.observeHistogram("dur", 0.3);
		c.observeHistogram("dur", 2.0);

		const text = c.renderPrometheus();
		assert.ok(text.includes('dur_bucket{le="0.1"} 1'));
		assert.ok(text.includes('dur_bucket{le="0.5"} 2'));
		assert.ok(text.includes('dur_bucket{le="1"} 2'));
		assert.ok(text.includes('dur_bucket{le="+Inf"} 3'));
		assert.ok(text.includes("dur_count 3"));
	});

	test("supports EPG duration buckets", () => {
		const c = new MetricsCollector().registerHistogram(
			"epg_refresh_duration_seconds",
			"EPG duration",
			EPG_DURATION_BUCKETS
		);
		c.observeHistogram("epg_refresh_duration_seconds", 12.5);

		const snap = c.getHistogram("epg_refresh_duration_seconds");
		assert.ok(snap);
		assert.equal(snap.count, 1);
		assert.ok(Math.abs(snap.sum - 12.5) < 1e-9);
	});
});

// ---------------------------------------------------------------------------
// MetricsCollector — snapshot
// ---------------------------------------------------------------------------

describe("MetricsCollector – snapshot", () => {
	test("snapshot returns all tracked metrics", () => {
		const c = new MetricsCollector()
			.registerCounter("c", "counter")
			.registerGauge("g", "gauge")
			.registerHistogram("h", "histogram", [1]);

		c.incrementCounter("c");
		c.setGauge("g", 5);
		c.observeHistogram("h", 0.5);

		const snap = c.snapshot();
		assert.ok("counter:c" in snap);
		assert.ok("gauge:g" in snap);
		assert.ok("histogram:h" in snap);
	});
});

// ---------------------------------------------------------------------------
// MetricsCollector — createMetricsMiddleware (smoke test)
// ---------------------------------------------------------------------------

describe("createMetricsMiddleware", () => {
	test("increments counter after response finish", (t, done) => {
		const collector = new MetricsCollector()
			.registerCounter("http_requests_total", "Requests")
			.registerHistogram(
				"http_request_duration_seconds",
				"Duration",
				HTTP_DURATION_BUCKETS
			);

		const middleware = createMetricsMiddleware(collector);

		// Minimal Express-like stubs
		const req = { method: "GET", path: "/health", route: undefined } as never;
		const handlers: { finish: (() => void)[] } = { finish: [] };
		const res = {
			on(event: string, handler: () => void) {
				if (event === "finish") handlers.finish.push(handler);
			},
			statusCode: 200
		} as never;

		middleware(req, res, () => {
			// Simulate response finishing after the route runs.
			for (const h of handlers.finish) h();

			assert.equal(
				collector.getCounter("http_requests_total", {
					method: "GET",
					route: "/health",
					status: "200"
				}),
				1
			);

			const hist = collector.getHistogram("http_request_duration_seconds", {
				method: "GET",
				route: "/health"
			});
			assert.ok(hist);
			assert.equal(hist.count, 1);
			assert.ok(hist.sum >= 0);

			done();
		});
	});
});

// ---------------------------------------------------------------------------
// diagnostics — collectSystemInfo
// ---------------------------------------------------------------------------

describe("diagnostics – collectSystemInfo", () => {
	test("returns expected fields", () => {
		const info = collectSystemInfo();
		assert.equal(typeof info.timestamp, "string");
		assert.equal(typeof info.node, "string");
		assert.equal(typeof info.platform, "string");
		assert.ok(info.os);
		assert.ok(info.process);
	});
});

// ---------------------------------------------------------------------------
// diagnostics — collectRecentLog
// ---------------------------------------------------------------------------

describe("diagnostics – collectRecentLog", () => {
	test("returns null for a non-existent file", async () => {
		const result = await collectRecentLog("/does/not/exist/signalhaven.log");
		assert.equal(result, null);
	});

	test("returns empty buffer for an empty file", async () => {
		const tmpFile = join(tmpdir(), `signalhaven-test-empty-${Date.now()}.log`);
		await writeFile(tmpFile, "");
		try {
			const result = await collectRecentLog(tmpFile);
			assert.ok(result !== null);
			assert.equal(result.length, 0);
		} finally {
			await rm(tmpFile, { force: true });
		}
	});

	test("returns the file content for a small file", async () => {
		const tmpFile = join(tmpdir(), `signalhaven-test-log-${Date.now()}.log`);
		const content = '{"level":30,"msg":"test"}\n';
		await writeFile(tmpFile, content);
		try {
			const result = await collectRecentLog(tmpFile);
			assert.ok(result !== null);
			assert.equal(result.toString(), content);
		} finally {
			await rm(tmpFile, { force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// diagnostics — collectDbStats (stub pool)
// ---------------------------------------------------------------------------

describe("diagnostics – collectDbStats", () => {
	test("formats table stats from pool result", async () => {
		const fakePool = {
			query: async () => ({
				rows: [
					{
						schemaname: "public",
						tablename: "channels",
						n_live_tup: "42",
						n_dead_tup: "1",
						last_autovacuum: null,
						last_autoanalyze: null
					}
				]
			})
		} as unknown as import("pg").Pool;

		const stats = (await collectDbStats(fakePool)) as {
			tables: Array<{ tablename: string; n_live_tup: string }>;
		};

		assert.equal(stats.tables.length, 1);
		assert.equal(stats.tables[0]?.tablename, "channels");
		assert.equal(stats.tables[0]?.n_live_tup, "42");
	});
});

// ---------------------------------------------------------------------------
// diagnostics — generateDiagnosticsBundle (full integration, no real DB/fs)
// ---------------------------------------------------------------------------

describe("diagnostics – generateDiagnosticsBundle", () => {
	test("generates a non-empty ZIP buffer with system info and metrics", async () => {
		const collector = new MetricsCollector()
			.registerCounter("http_requests_total", "Requests")
			.registerGauge("stream_sessions_active", "Sessions");
		collector.incrementCounter("http_requests_total");
		collector.setGauge("stream_sessions_active", 2);

		const buf = await generateDiagnosticsBundle({ metrics: collector });

		// ZIP files start with the local file header signature 0x04034b50
		assert.ok(buf.length > 4);
		assert.equal(buf[0], 0x50); // 'P'
		assert.equal(buf[1], 0x4b); // 'K'
		assert.equal(buf[2], 0x03);
		assert.equal(buf[3], 0x04);
	});

	test("generates a bundle without optional dependencies", async () => {
		const buf = await generateDiagnosticsBundle({});
		assert.ok(buf.length > 0);
	});
});

// ---------------------------------------------------------------------------
// error-reporter — noopReporter
// ---------------------------------------------------------------------------

describe("error-reporter", () => {
	test("noopReporter does not throw", () => {
		assert.doesNotThrow(() => {
			noopReporter.report(new Error("test"));
			noopReporter.report(new Error("ctx"), { requestId: "abc" });
		});
	});

	test("createErrorReporter returns noop by default", () => {
		const reporter = createErrorReporter({});
		assert.doesNotThrow(() => reporter.report(new Error("default")));
	});
});
