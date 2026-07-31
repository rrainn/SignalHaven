import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config";
import { checkHealth, monitorHealth, type HealthProbe } from "../src/health";
import { AdvertisementSupervisor } from "../src/supervisor";

test("checks health through the canonical HTTPS URL", async () => {
	const config = loadConfig({ PUBLIC_URL: "https://service.example.com/base" });
	let requestedUrl: string | undefined;
	const fetchHealth: typeof fetch = async (input) => {
		requestedUrl = input.toString();
		return new Response(null, { status: 200 });
	};

	const healthy = await checkHealth(
		config,
		new AbortController().signal,
		fetchHealth
	);

	assert.equal(healthy, true);
	assert.equal(requestedUrl, "https://service.example.com/base/api/v1/health");
});

test("reports the canonical endpoint unhealthy after a failed probe", async () => {
	const config = loadConfig({ PUBLIC_URL: "https://service.example.com" });
	const fetchHealth: typeof fetch = async () =>
		new Response(null, { status: 503 });

	assert.equal(
		await checkHealth(config, new AbortController().signal, fetchHealth),
		false
	);
});

test("advertises only after health succeeds and withdraws after failure", async () => {
	const config = {
		...loadConfig({ PUBLIC_URL: "https://service.example.com" }),
		healthIntervalMs: 0
	};
	const events: string[] = [];
	const supervisor = new AdvertisementSupervisor(async () => {
		events.push("advertise");
		return {
			stop: async () => {
				events.push("withdraw");
			}
		};
	});
	const shutdown = new AbortController();
	const observations = [false, true, false];
	const probe: HealthProbe = async () => {
		const observation = observations.shift() ?? false;
		if (observations.length === 0) {
			shutdown.abort();
		}
		return observation;
	};

	await monitorHealth(config, supervisor, shutdown.signal, probe);

	assert.deepEqual(events, ["advertise", "withdraw"]);
});
