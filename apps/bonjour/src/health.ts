import type { BonjourConfig } from "./config";
import { errorMessage, logEvent } from "./logger";
import type { AdvertisementSupervisor } from "./supervisor";

/** Checks the public host endpoint with a bounded request lifetime. */
export async function checkHealth(
	config: BonjourConfig,
	signal: AbortSignal
): Promise<boolean> {
	try {
		const response = await fetch(config.healthUrl, {
			signal: AbortSignal.any([
				signal,
				AbortSignal.timeout(config.healthTimeoutMs)
			])
		});
		return response.status === 200;
	} catch (error) {
		if (!signal.aborted) {
			logEvent("health-check-failed", { error: errorMessage(error) });
		}
		return false;
	}
}

/** Waits between probes while allowing shutdown to interrupt immediately. */
function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}

		const timeout = setTimeout(done, milliseconds);
		function done(): void {
			clearTimeout(timeout);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

/** Monitors health continuously and withdraws discovery when service is unavailable. */
export async function monitorHealth(
	config: BonjourConfig,
	supervisor: AdvertisementSupervisor,
	signal: AbortSignal
): Promise<void> {
	let previousHealth: boolean | undefined;

	try {
		while (!signal.aborted) {
			const healthy = await checkHealth(config, signal);
			if (healthy !== previousHealth) {
				logEvent("health-changed", { healthy });
				previousHealth = healthy;
			}

			try {
				await supervisor.reconcile(healthy);
			} catch (error) {
				logEvent("advertisement-transition-failed", {
					error: errorMessage(error),
					healthy
				});
			}

			await wait(config.healthIntervalMs, signal);
		}
	} finally {
		await supervisor.stop();
	}
}
