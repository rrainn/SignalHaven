import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
	userPreferencesDefaults,
	type UserPreferences
} from "@signalhaven/shared";

import type { EventBus } from "../src/events/event-bus";
import type { UserPreferencesRepository } from "../src/repositories/user-preferences.repository";
import { UserPreferencesService } from "../src/settings/user-preferences.service";

class InMemoryPreferencesRepository {
	private readonly rows = new Map<
		string,
		Map<string, Record<string, unknown>>
	>();

	async listForUser(
		userId: string
	): Promise<Record<string, Record<string, unknown>>> {
		return Object.fromEntries(this.rows.get(userId) ?? []);
	}

	async upsertManyForUser(
		userId: string,
		updates: Record<string, Record<string, unknown>>
	): Promise<void> {
		const rows = this.rows.get(userId) ?? new Map();
		for (const [key, value] of Object.entries(updates)) rows.set(key, value);
		this.rows.set(userId, rows);
	}
}

test("preferences default independently and writes never cross user boundaries", async () => {
	const published: unknown[] = [];
	const repository = new InMemoryPreferencesRepository();
	const bus = {
		publish: (event: unknown) => published.push(event)
	} as unknown as EventBus;
	const service = new UserPreferencesService({
		repository: repository as unknown as UserPreferencesRepository,
		bus
	});
	const firstUser = randomUUID();
	const secondUser = randomUUID();

	assert.deepEqual(await service.getAll(firstUser), userPreferencesDefaults);
	const updated = await service.patch(firstUser, {
		ui: { ...userPreferencesDefaults.ui, epgHoursVisible: 8 }
	});

	assert.equal(updated.ui.epgHoursVisible, 8);
	assert.deepEqual(await service.getAll(secondUser), userPreferencesDefaults);
	assert.equal(published.length, 1);
	assert.equal(
		(published[0] as { audience?: { userId?: string } }).audience?.userId,
		firstUser
	);
});

test("preference responses retain only ui, channels, and player", async () => {
	const service = new UserPreferencesService({
		repository:
			new InMemoryPreferencesRepository() as unknown as UserPreferencesRepository
	});
	const preferences: UserPreferences = await service.getAll(randomUUID());

	assert.deepEqual(Object.keys(preferences).sort(), [
		"channels",
		"player",
		"ui"
	]);
});
