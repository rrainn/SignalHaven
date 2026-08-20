import {
	userPreferencesDefaults,
	userPreferencesPatchSchema,
	userPreferencesSchema,
	type UserPreferences
} from "@signalhaven/shared";

import type { EventBus } from "../events/event-bus";
import type { UserPreferencesRepository } from "../repositories/user-preferences.repository";

export class UserPreferencesService {
	constructor(
		private readonly options: {
			/** A narrow port keeps user isolation testable without a second persistence path. */
			repository: Pick<
				UserPreferencesRepository,
				"listForUser" | "upsertManyForUser"
			>;
			bus?: EventBus;
		}
	) {}

	async getAll(userId: string): Promise<UserPreferences> {
		const stored = await this.options.repository.listForUser(userId);
		return userPreferencesSchema.parse({
			...userPreferencesDefaults,
			...stored
		});
	}

	async patch(userId: string, input: unknown): Promise<UserPreferences> {
		const patch = userPreferencesPatchSchema.parse(input);
		const updates = Object.fromEntries(
			Object.entries(patch).filter((entry) => entry[1] !== undefined)
		) as Record<string, Record<string, unknown>>;
		await this.options.repository.upsertManyForUser(userId, updates);
		const updated = await this.getAll(userId);
		this.options.bus?.publish({
			topic: "settings",
			event: "preferences.updated",
			data: updated,
			audience: { userId }
		});
		return updated;
	}
}
