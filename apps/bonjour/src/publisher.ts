import {
	getResponder,
	Protocol,
	type CiaoService,
	type Responder
} from "@homebridge/ciao";

import type { BonjourConfig } from "./config";
import { logEvent } from "./logger";
import type { AdvertisementRegistration } from "./supervisor";

/** Builds the versioned, security-sensitive discovery data clients validate. */
export function createTxtRecord(
	config: BonjourConfig,
	serverId: string
): Record<string, string> {
	return {
		txtvers: "2",
		protovers: "2",
		url: config.publicUrl,
		id: serverId
	};
}

/** Publishes SignalHaven through one shared, interface-aware mDNS responder. */
export class BonjourPublisher {
	private readonly responder: Responder;

	public constructor(
		private readonly config: BonjourConfig,
		private readonly serverId: string
	) {
		// Ciao uses shared UDP sockets and watches host interfaces for address changes.
		this.responder = getResponder();
	}

	/** Creates and announces one DNS-SD service registration. */
	public async advertise(): Promise<AdvertisementRegistration> {
		const service = this.createService();
		service.on("name-change", (name) => {
			logEvent("service-name-changed", { name });
		});
		service.on("hostname-change", (hostname) => {
			logEvent("service-hostname-changed", { hostname });
		});

		try {
			await service.advertise();
		} catch (error) {
			// A failed probe still owns responder resources until explicitly destroyed.
			await service.destroy();
			throw error;
		}
		logEvent("advertised", {
			fqdn: service.getFQDN(),
			hostname: service.getHostname(),
			port: this.config.port,
			publicUrl: this.config.publicUrl,
			serverId: this.serverId
		});

		let stopped = false;
		return {
			stop: async () => {
				if (stopped) {
					return;
				}
				stopped = true;
				await service.destroy();
				logEvent("withdrawn", { serverId: this.serverId });
			}
		};
	}

	/** Releases multicast sockets after all services have sent goodbye packets. */
	public async shutdown(): Promise<void> {
		await this.responder.shutdown();
	}

	/** Builds records from validated configuration and intentionally small TXT data. */
	private createService(): CiaoService {
		return this.responder.createService({
			name: this.config.serviceName,
			hostname: `signalhaven-${this.serverId.slice(0, 8)}`,
			type: "signalhaven",
			protocol: Protocol.TCP,
			port: this.config.port,
			txt: createTxtRecord(this.config, this.serverId),
			...(this.config.restrictedAddresses
				? { restrictedAddresses: this.config.restrictedAddresses }
				: {}),
			disabledIpv6: this.config.disabledIpv6
		});
	}
}
