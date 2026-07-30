import assert from "node:assert/strict";
import test from "node:test";

import { RemoteImageProxy } from "../src/media/remote-image-proxy";

test("RemoteImageProxy fetches, validates, and caches image bytes", async () => {
	let fetchCount = 0;
	const proxy = new RemoteImageProxy({
		resolveHost: async () => ["203.0.113.1"],
		fetch: async () => {
			fetchCount += 1;
			return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
				status: 200,
				headers: { "Content-Type": "image/png" }
			});
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
	assert.deepEqual(first?.body, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
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

test("RemoteImageProxy enforces the response size cap while streaming", async () => {
	const proxy = new RemoteImageProxy({
		maxBytes: 4,
		resolveHost: async () => ["203.0.113.1"],
		fetch: async () =>
			new Response(new Uint8Array([1, 2, 3, 4, 5]), {
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
