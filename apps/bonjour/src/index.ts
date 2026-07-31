import { loadConfig } from "./config";
import { monitorHealth } from "./health";
import { loadOrCreateServerId } from "./identity";
import { errorMessage, logEvent } from "./logger";
import { BonjourPublisher } from "./publisher";
import { AdvertisementSupervisor } from "./supervisor";

/** Starts discovery and keeps it aligned with the canonical HTTPS endpoint. */
async function main(): Promise<void> {
	const config = loadConfig(process.env);
	const serverId =
		config.serverId ?? (await loadOrCreateServerId(config.stateDirectory));
	const publisher = new BonjourPublisher(config, serverId);
	const supervisor = new AdvertisementSupervisor(() => publisher.advertise());
	const shutdown = new AbortController();

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			logEvent("shutdown-requested", { signal });
			shutdown.abort();
		});
	}

	logEvent("started", {
		port: config.port,
		publicUrl: config.publicUrl,
		serviceName: config.serviceName,
		serverId
	});

	try {
		await monitorHealth(config, supervisor, shutdown.signal);
	} finally {
		await publisher.shutdown();
		logEvent("stopped", { serverId });
	}
}

main().catch((error) => {
	logEvent("fatal", { error: errorMessage(error) });
	process.exitCode = 1;
});
