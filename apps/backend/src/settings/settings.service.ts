import {
	settingsDefaults,
	settingsPatchSchema,
	settingsSchema,
	type Settings,
	type SettingsPatch
} from "@signalhaven/shared";
import { ZodError } from "zod";

import type { EventBus } from "../events/event-bus";
import type { SettingsRepository } from "../repositories/settings.repository";

export interface SettingsServiceOptions {
	repository: SettingsRepository;
	/** Optional bus; when provided, change events are published to "settings". */
	bus?: EventBus;
}

/**
 * Typed facade over the raw `settings` table. Returns a fully populated
 * `Settings` object (defaults filled in for any unset key) and validates
 * every write against the per-key zod schema before persisting.
 *
 * Storing each top-level key as its own DB row (rather than one giant blob)
 * keeps PATCH semantics natural: a patch only touches the rows in its body,
 * unrelated keys survive untouched even if a future code version adds new
 * keys.
 */
export class SettingsService {
	private readonly repository: SettingsRepository;
	private readonly bus: EventBus | undefined;

	constructor(options: SettingsServiceOptions) {
		this.repository = options.repository;
		this.bus = options.bus;
	}

	/**
	 * Returns the merged settings document: persisted values overlaid on top
	 * of `settingsDefaults`. Unknown keys present in the DB are ignored so a
	 * stale row from an older app version never breaks reads.
	 */
	async getAll(): Promise<Settings> {
		const stored = await this.repository.listAll();
		const merged = mergeSettings(stored);
		// Validate the final document so a corrupted row surfaces as an error
		// instead of silently returning bad data to the API.
		return settingsSchema.parse(merged);
	}

	/**
	 * Applies a partial update. Each top-level key in `input` replaces the
	 * stored value for that key in full (the per-key schema is applied
	 * strictly); keys not mentioned are left untouched. Returns the merged
	 * `Settings` document after the update.
	 *
	 * Throws a `ZodError` if the patch is invalid; callers (or the validate
	 * middleware on the route) should translate that to HTTP 400.
	 */
	async patch(input: unknown): Promise<Settings> {
		const patch = settingsPatchSchema.parse(input) as SettingsPatch;
		const updates: Record<string, Record<string, unknown>> = {};
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) {
				continue;
			}
			updates[key] = value as Record<string, unknown>;
		}

		if (Object.keys(updates).length > 0) {
			await this.repository.upsertMany(updates);
		}

		const next = await this.getAll();

		if (this.bus && Object.keys(updates).length > 0) {
			this.bus.publish({
				topic: "settings",
				event: "updated",
				data: {
					changedKeys: Object.keys(updates),
					settings: next
				}
			});
		}

		return next;
	}
}

export { ZodError as SettingsValidationError };

function mergeSettings(stored: Record<string, unknown>): Settings {
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(settingsDefaults) as Array<keyof Settings>) {
		const defaultValue = settingsDefaults[key];
		const storedValue = stored[key];
		if (storedValue && typeof storedValue === "object") {
			result[key] = {
				...(defaultValue as object),
				...(storedValue as object)
			};
		} else {
			result[key] = defaultValue;
		}
	}
	return result as Settings;
}
