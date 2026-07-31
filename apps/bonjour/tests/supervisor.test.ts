import assert from "node:assert/strict";
import test from "node:test";

import {
	AdvertisementSupervisor,
	type AdvertisementRegistration
} from "../src/supervisor";

/** Records registration changes without opening multicast sockets. */
function createRegistrationRecorder(): {
	create: () => Promise<AdvertisementRegistration>;
	events: string[];
} {
	const events: string[] = [];

	return {
		events,
		create: async () => {
			events.push("advertise");
			return {
				stop: async () => {
					events.push("withdraw");
				}
			};
		}
	};
}

test("advertises only while SignalHaven is healthy", async () => {
	const recorder = createRegistrationRecorder();
	const supervisor = new AdvertisementSupervisor(recorder.create);

	await supervisor.reconcile(false);
	await supervisor.reconcile(true);
	await supervisor.reconcile(true);
	await supervisor.reconcile(false);

	assert.deepEqual(recorder.events, ["advertise", "withdraw"]);
});

test("re-advertises after health recovers", async () => {
	const recorder = createRegistrationRecorder();
	const supervisor = new AdvertisementSupervisor(recorder.create);

	await supervisor.reconcile(true);
	await supervisor.reconcile(false);
	await supervisor.reconcile(true);
	await supervisor.stop();

	assert.deepEqual(recorder.events, [
		"advertise",
		"withdraw",
		"advertise",
		"withdraw"
	]);
});

test("serializes overlapping health transitions", async () => {
	const events: string[] = [];
	let releaseRegistration: (() => void) | undefined;
	const registrationReady = new Promise<void>((resolve) => {
		releaseRegistration = resolve;
	});
	const supervisor = new AdvertisementSupervisor(async () => {
		events.push("advertise:start");
		await registrationReady;
		events.push("advertise:ready");
		return {
			stop: async () => {
				events.push("withdraw");
			}
		};
	});

	const advertise = supervisor.reconcile(true);
	const withdraw = supervisor.reconcile(false);
	releaseRegistration?.();
	await Promise.all([advertise, withdraw]);

	assert.deepEqual(events, ["advertise:start", "advertise:ready", "withdraw"]);
});
