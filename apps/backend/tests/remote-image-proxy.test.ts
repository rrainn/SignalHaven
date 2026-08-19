import assert from "node:assert/strict";
import test from "node:test";

import { RemoteImageProxy } from "../src/media/remote-image-proxy";

test("RemoteImageProxy fetches, validates, and caches image bytes", async () => {
	let fetchCount = 0;
	const proxy = new RemoteImageProxy({
		resolveHost: async () => ["203.0.113.1"],
		fetch: async () => {
			fetchCount += 1;
			return new Response(
				new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
				{
					status: 200,
					headers: { "Content-Type": "image/png" }
				}
			);
		}
	});

	const first = await proxy.get(
		"recording-1",
		"https://images.example/show.png"
	);
	const second = await proxy.get(
		"recording-1",
		"https://images.example/show.png"
	);

	assert.equal(first?.contentType, "image/png");
	assert.deepEqual(
		first?.body,
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
	);
	assert.equal(second?.body, first?.body);
	assert.equal(fetchCount, 1);
});

test("RemoteImageProxy rejects unsupported URLs and non-image responses", async () => {
	let fetchCount = 0;
	const proxy = new RemoteImageProxy({
		resolveHost: async () => ["203.0.113.1"],
		fetch: async () => {
			fetchCount += 1;
			return new Response("not an image", {
				status: 200,
				headers: { "Content-Type": "text/plain" }
			});
		}
	});

	assert.equal(await proxy.get("one", "file:///etc/passwd"), null);
	assert.equal(
		await proxy.get("two", "https://images.example/not-image"),
		null
	);
	assert.equal(fetchCount, 1);
});

test("RemoteImageProxy rejects SVG and raster content-type spoofing", async () => {
	const responses = [
		new Response('<svg xmlns="http://www.w3.org/2000/svg"><script /></svg>', {
			headers: { "Content-Type": "image/svg+xml" }
		}),
		new Response("<script>steal()</script>", {
			headers: { "Content-Type": "image/png" }
		})
	];
	const proxy = new RemoteImageProxy({
		resolveHost: async () => ["203.0.113.1"],
		fetch: async () => responses.shift()!
	});

	assert.equal(await proxy.get("svg", "https://images.example/logo.svg"), null);
	assert.equal(
		await proxy.get("spoof", "https://images.example/logo.png"),
		null
	);
});

test("RemoteImageProxy enforces the response size cap while streaming", async () => {
	const proxy = new RemoteImageProxy({
		maxBytes: 4,
		resolveHost: async () => ["203.0.113.1"],
		fetch: async () =>
			new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2]), {
				status: 200,
				headers: { "Content-Type": "image/jpeg" }
			})
	});

	assert.equal(
		await proxy.get("recording-1", "https://images.example/large.jpg"),
		null
	);
});

test("RemoteImageProxy rejects hosts that resolve to private addresses", async () => {
	let fetchCount = 0;
	const proxy = new RemoteImageProxy({
		resolveHost: async () => ["127.0.0.1"],
		fetch: async () => {
			fetchCount += 1;
			return new Response(new Uint8Array([1]), {
				headers: { "Content-Type": "image/png" }
			});
		}
	});

	assert.equal(await proxy.get("recording-1", "https://internal.test/a"), null);
	assert.equal(fetchCount, 0);
});

test("RemoteImageProxy validates redirect targets before following them", async () => {
	let fetchCount = 0;
	const proxy = new RemoteImageProxy({
		resolveHost: async () => ["203.0.113.1"],
		fetch: async () => {
			fetchCount += 1;
			return new Response(null, {
				status: 302,
				headers: { Location: "http://127.0.0.1/private.png" }
			});
		}
	});

	assert.equal(await proxy.get("one", "https://images.example/start"), null);
	assert.equal(fetchCount, 1);
});

test("RemoteImageProxy pins the address returned by the validated DNS lookup", async () => {
	let lookups = 0;
	const proxy = new RemoteImageProxy({
		resolveHost: async () => {
			lookups += 1;
			return lookups === 1 ? ["203.0.113.9"] : ["127.0.0.1"];
		},
		fetch: async (_url, options) => {
			assert.deepEqual(options.addresses, ["203.0.113.9"]);
			return new Response(
				new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
				{ headers: { "Content-Type": "image/png" } }
			);
		}
	});

	assert.ok(await proxy.get("logo", "https://changing-dns.example/logo.png"));
	assert.equal(lookups, 1);
});

test("RemoteImageProxy evicts cached images by total bytes, not only count", async () => {
	let fetchCount = 0;
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const proxy = new RemoteImageProxy({
		maxCacheBytes: png.byteLength,
		resolveHost: async () => ["203.0.113.1"],
		fetch: async () => {
			fetchCount += 1;
			return new Response(png, { headers: { "Content-Type": "image/png" } });
		}
	});

	await proxy.get("first", "https://images.example/first.png");
	await proxy.get("second", "https://images.example/second.png");
	await proxy.get("first", "https://images.example/first.png");
	assert.equal(fetchCount, 3);
});

test("RemoteImageProxy bounds distinct in-flight image requests", async () => {
	let release: (() => void) | undefined;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const proxy = new RemoteImageProxy({
		maxConcurrent: 1,
		resolveHost: async () => ["203.0.113.1"],
		fetch: async () => {
			await blocked;
			return new Response(png, { headers: { "Content-Type": "image/png" } });
		}
	});

	const first = proxy.get("first", "https://images.example/first.png");
	await Promise.resolve();
	assert.equal(
		await proxy.get("second", "https://images.example/second.png"),
		null
	);
	release?.();
	assert.ok(await first);
});

test("RemoteImageProxy briefly negative-caches provider failures", async () => {
	let now = 1_000;
	let fetchCount = 0;
	const proxy = new RemoteImageProxy({
		now: () => now,
		negativeTtlMs: 100,
		resolveHost: async () => ["203.0.113.1"],
		fetch: async () => {
			fetchCount += 1;
			return new Response("unavailable", { status: 503 });
		}
	});

	assert.equal(
		await proxy.get("logo", "https://images.example/logo.png"),
		null
	);
	assert.equal(
		await proxy.get("logo", "https://images.example/logo.png"),
		null
	);
	assert.equal(fetchCount, 1);
	now += 101;
	assert.equal(
		await proxy.get("logo", "https://images.example/logo.png"),
		null
	);
	assert.equal(fetchCount, 2);
});
