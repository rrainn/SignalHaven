import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	clearServiceWorkerState,
	ServiceWorkerRegistrar
} from "../../app/_pwa/ServiceWorkerRegistrar";

const originalServiceWorker = Object.getOwnPropertyDescriptor(
	navigator,
	"serviceWorker"
);
const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");

describe("ServiceWorkerRegistrar", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		if (originalServiceWorker) {
			Object.defineProperty(navigator, "serviceWorker", originalServiceWorker);
		} else {
			Reflect.deleteProperty(navigator, "serviceWorker");
		}
		if (originalCaches) {
			Object.defineProperty(globalThis, "caches", originalCaches);
		} else {
			Reflect.deleteProperty(globalThis, "caches");
		}
	});

	it("removes production workers and caches outside production", async () => {
		const unregister = vi.fn().mockResolvedValue(true);
		const register = vi.fn();
		const deleteCache = vi.fn().mockResolvedValue(true);

		Object.defineProperty(navigator, "serviceWorker", {
			configurable: true,
			value: {
				controller: null,
				getRegistrations: vi.fn().mockResolvedValue([{ unregister }]),
				register
			}
		});
		Object.defineProperty(globalThis, "caches", {
			configurable: true,
			value: {
				keys: vi
					.fn()
					.mockResolvedValue(["signalhaven-shell-v1", "unrelated-cache"]),
				delete: deleteCache
			}
		});

		render(<ServiceWorkerRegistrar />);

		await waitFor(() => expect(unregister).toHaveBeenCalledOnce());
		expect(deleteCache).toHaveBeenCalledWith("signalhaven-shell-v1");
		expect(deleteCache).not.toHaveBeenCalledWith("unrelated-cache");
		expect(register).not.toHaveBeenCalled();
	});

	it("reloads a document that was already controlled by the removed worker", async () => {
		const reload = vi.fn();

		await clearServiceWorkerState({
			serviceWorker: {
				controller: {} as ServiceWorker,
				getRegistrations: vi.fn().mockResolvedValue([])
			} as unknown as ServiceWorkerContainer,
			reload
		});

		expect(reload).toHaveBeenCalledOnce();
	});
});
