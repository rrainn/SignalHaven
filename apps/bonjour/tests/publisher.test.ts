import assert from "node:assert/strict";
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import os from "node:os";
import test from "node:test";

import { MDNSServer } from "@homebridge/ciao/lib/MDNSServer";

import { loadConfig } from "../src/config";
import { BonjourPublisher, createTxtRecord } from "../src/publisher";

/** Keeps Ciao's real interface selection while replacing the host UDP boundary. */
class RecordingSocket extends EventEmitter {
	public constructor(private readonly memberships: string[]) {
		super();
	}

	public bind(_port: number, callback: () => void): void {
		queueMicrotask(callback);
	}

	public addMembership(_group: string, address: string): void {
		this.memberships.push(address);
	}

	// Socket tuning is irrelevant to which interfaces receive multicast traffic.
	public setRecvBufferSize(): void {}
	public setMulticastInterface(): void {}
	public setMulticastTTL(): void {}
	public setTTL(): void {}
	public setMulticastLoopback(): void {}

	public close(): void {
		this.emit("close");
	}
}

/** Models the affected Linux host without depending on the test runner's network. */
function hostInterfaces(): NodeJS.Dict<os.NetworkInterfaceInfo[]> {
	const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {};
	for (const [name, address] of [
		["lo", "127.0.0.1"],
		["lan", "10.0.1.77"],
		...Array.from({ length: 30 }, (_, index) => [
			`docker${index}`,
			`172.${index + 16}.0.1`
		])
	] as [string, string][]) {
		interfaces[name] = [
			{
				address,
				family: "IPv4",
				internal: name === "lo",
				netmask: "255.255.255.0",
				mac: "00:00:00:00:00:00",
				cidr: `${address}/24`
			}
		];
	}
	return interfaces;
}

for (const restriction of ["10.0.1.77", "lan", "lan,docker0", undefined]) {
	test(`responder joins only selected interfaces plus Ciao loopback: ${restriction ?? "unrestricted"}`, async (context) => {
		const interfaces = hostInterfaces();
		const memberships: string[] = [];
		context.mock.method(os, "networkInterfaces", () => interfaces);
		// Avoid platform-specific route commands; Ciao falls back to these interfaces.
		context.mock.method(os, "platform", () => "test");
		context.mock.method(
			dgram,
			"createSocket",
			() => new RecordingSocket(memberships)
		);
		const bind = MDNSServer.prototype.bind;
		let resolveBound!: () => void;
		const bound = new Promise<void>((resolve) => {
			resolveBound = resolve;
		});
		context.mock.method(
			MDNSServer.prototype,
			"bind",
			async function (this: MDNSServer) {
				await bind.call(this);
				resolveBound();
			}
		);
		const publisher = new BonjourPublisher(
			loadConfig({
				PUBLIC_URL: "https://service.example.com",
				...(restriction ? { SIGNALHAVEN_BONJOUR_INTERFACES: restriction } : {})
			}),
			"f22b18a0-f7f1-40fd-9225-2da245803a47"
		);
		try {
			await bound;
			const expected =
				restriction === undefined
					? Object.values(interfaces).flatMap(
							(entries) => entries?.map((entry) => entry.address) ?? []
						)
					: [
							"10.0.1.77",
							"127.0.0.1",
							...(restriction.includes("docker0") ? ["172.16.0.1"] : [])
						];
			assert.deepEqual([...memberships].sort(), [...expected].sort());
		} finally {
			await publisher.shutdown();
		}
	});
}

test("publishes the canonical URL with the version 2 discovery contract", () => {
	const config = loadConfig({
		PUBLIC_URL: "https://service.example.com/base/"
	});

	assert.deepEqual(
		createTxtRecord(config, "f22b18a0-f7f1-40fd-9225-2da245803a47"),
		{
			txtvers: "2",
			protovers: "2",
			url: "https://service.example.com/base",
			id: "f22b18a0-f7f1-40fd-9225-2da245803a47"
		}
	);
});
