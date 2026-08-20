import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { beforeEach, describe, expect, it, vi } from "vitest";

type WorkerEvent = {
	request?: {
		method: string;
		url: string;
		mode: string;
		headers: Headers;
	};
	respondWith?: (response: Promise<unknown>) => void;
	waitUntil?: (work: Promise<unknown>) => void;
};

type WorkerHandler = (event: WorkerEvent) => void;

const serviceWorkerSource = readFileSync(
	resolve(process.cwd(), "public/sw.js"),
	"utf8"
);

/** Executes the production worker against controlled browser seams. */
function createWorkerHarness() {
	const handlers = new Map<string, WorkerHandler>();
	const cache = {
		add: vi.fn(async () => undefined),
		put: vi.fn(async () => undefined)
	};
	const cacheStorage = {
		open: vi.fn(async () => cache),
		keys: vi.fn(async () => [] as string[]),
		delete: vi.fn(async () => true),
		match: vi.fn<(request: string) => Promise<unknown>>(async () => undefined)
	};
	const fetchImpl = vi.fn<() => Promise<unknown>>();
	const worker = {
		location: { origin: "https://signalhaven.test" },
		addEventListener: (name: string, handler: WorkerHandler) => {
			handlers.set(name, handler);
		},
		skipWaiting: vi.fn(),
		clients: { claim: vi.fn() }
	};
	runInNewContext(serviceWorkerSource, {
		URL,
		Promise,
		caches: cacheStorage,
		fetch: fetchImpl,
		self: worker
	});
	return { cache, cacheStorage, fetchImpl, handlers };
}

describe("service worker account cache policy", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("never installs account-owned root HTML into the shared shell cache", async () => {
		const { cache, handlers } = createWorkerHarness();
		let installation: Promise<unknown> | undefined;
		handlers.get("install")?.({
			waitUntil: (work) => {
				installation = work;
			}
		});
		await installation;

		expect(cache.add).not.toHaveBeenCalledWith("/");
		expect(cache.add).toHaveBeenCalledWith("/offline.html");
	});

	it("serves navigation from the network without writing private HTML", async () => {
		const { cache, fetchImpl, handlers } = createWorkerHarness();
		const response = { clone: vi.fn() };
		fetchImpl.mockResolvedValue(response);
		let navigation: Promise<unknown> | undefined;
		handlers.get("fetch")?.({
			request: {
				method: "GET",
				url: "https://signalhaven.test/recordings",
				mode: "navigate",
				headers: new Headers()
			},
			respondWith: (work) => {
				navigation = work;
			}
		});

		await expect(navigation).resolves.toBe(response);
		expect(cache.put).not.toHaveBeenCalled();
	});

	it("falls back to a neutral offline page instead of another account's HTML", async () => {
		const { cache, cacheStorage, fetchImpl, handlers } = createWorkerHarness();
		const accountPage = { account: "first" };
		const offlinePage = { account: null };
		fetchImpl
			.mockResolvedValueOnce(accountPage)
			.mockRejectedValueOnce(new Error("offline"));
		cacheStorage.match.mockImplementation(async (request) =>
			request === "/offline.html" ? offlinePage : undefined
		);

		const navigate = (path: string) => {
			let navigation: Promise<unknown> | undefined;
			handlers.get("fetch")?.({
				request: {
					method: "GET",
					url: `https://signalhaven.test${path}`,
					mode: "navigate",
					headers: new Headers()
				},
				respondWith: (work) => {
					navigation = work;
				}
			});
			return navigation;
		};

		await expect(navigate("/recordings")).resolves.toBe(accountPage);
		await expect(navigate("/guide")).resolves.toBe(offlinePage);
		expect(cache.put).not.toHaveBeenCalled();
		expect(cacheStorage.match).toHaveBeenCalledTimes(1);
		expect(cacheStorage.match).toHaveBeenCalledWith("/offline.html");
	});

	it("leaves account-scoped Next RSC requests outside CacheStorage", () => {
		const { cacheStorage, fetchImpl, handlers } = createWorkerHarness();
		const respondWith = vi.fn();
		handlers.get("fetch")?.({
			request: {
				method: "GET",
				url: "https://signalhaven.test/settings?_rsc=private-tree",
				mode: "cors",
				headers: new Headers({ RSC: "1" })
			},
			respondWith
		});

		expect(respondWith).not.toHaveBeenCalled();
		expect(cacheStorage.match).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
