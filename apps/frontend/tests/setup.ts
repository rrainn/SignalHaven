import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Pointer-capture polyfills for jsdom — Radix UI primitives (Toast, Slider,
// etc.) call these on synthetic pointer events and jsdom's HTMLElement
// prototype does not implement them. Without these stubs the tests pass but
// an unhandled exception is logged and Vitest exits non-zero.
if (typeof Element !== "undefined") {
	if (!Element.prototype.hasPointerCapture) {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (!Element.prototype.setPointerCapture) {
		Element.prototype.setPointerCapture = () => undefined;
	}
	if (!Element.prototype.releasePointerCapture) {
		Element.prototype.releasePointerCapture = () => undefined;
	}
	// Radix Select scrolls the active item into view via scrollIntoView.
	if (!Element.prototype.scrollIntoView) {
		Element.prototype.scrollIntoView = () => undefined;
	}
}

// jsdom doesn't implement ResizeObserver; Radix Slider's `useSize`
// hook subscribes to one. Provide a no-op stub so any component
// rendering a Slider in tests doesn't blow up at mount time.
if (typeof globalThis.ResizeObserver === "undefined") {
	class ResizeObserverStub {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	}
	(globalThis as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
		ResizeObserverStub as unknown as typeof ResizeObserver;
}

// Node.js 22+ exposes a native globalThis.localStorage, but it requires
// --localstorage-file to function and lacks .clear(). Vitest's populateGlobal
// does not override it because 'localStorage' is absent from its built-in
// KEYS list, so the broken Node.js version leaks into the jsdom environment.
// Replace it with a proper in-memory implementation before any test runs.
{
	const localStore = new Map<string, string>();
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		enumerable: true,
		value: {
			/** Returns the value for the given key, or null if not found. */
			getItem(k: string): string | null {
				return localStore.get(k) ?? null;
			},
			/** Stores a string value for the given key. */
			setItem(k: string, v: string): void {
				localStore.set(k, String(v));
			},
			/** Removes the item with the given key. */
			removeItem(k: string): void {
				localStore.delete(k);
			},
			/** Removes all stored items. */
			clear(): void {
				localStore.clear();
			},
			/** Returns the key at the given index, or null if out of range. */
			key(n: number): string | null {
				return [...localStore.keys()][n] ?? null;
			},
			get length(): number {
				return localStore.size;
			}
		} as Storage
	});
}

// jsdom doesn't implement matchMedia; provide a controllable polyfill so
// theme tests can simulate `prefers-color-scheme: dark` flips.
type MqlListener = (e: MediaQueryListEvent) => void;

beforeEach(() => {
	const listeners = new Set<MqlListener>();
	let matches = false;

	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		writable: true,
		value: vi.fn().mockImplementation((query: string) => ({
			matches,
			media: query,
			onchange: null,
			addEventListener: (_: string, cb: MqlListener) => listeners.add(cb),
			removeEventListener: (_: string, cb: MqlListener) => listeners.delete(cb),
			addListener: (cb: MqlListener) => listeners.add(cb),
			removeListener: (cb: MqlListener) => listeners.delete(cb),
			dispatchEvent: () => true
		}))
	});

	// Helper exposed on window for tests that want to simulate an OS theme flip.
	(
		window as unknown as { __setPrefersDark: (value: boolean) => void }
	).__setPrefersDark = (value: boolean) => {
		matches = value;
		listeners.forEach((cb) =>
			cb({
				matches: value,
				media: "(prefers-color-scheme: dark)"
			} as MediaQueryListEvent)
		);
	};

	// Reset the document classList between tests.
	document.documentElement.classList.remove("dark");
	document.documentElement.style.colorScheme = "";
	window.localStorage.clear();
});

afterEach(() => {
	cleanup();
});
