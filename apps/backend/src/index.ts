import { bootstrapHwaccelDetection, createAppWithServices } from "./app";
import { closeDatabasePool, db, pool } from "./db/client";
import { shouldAutoMigrate } from "./db/config";
import { runMigrations } from "./db/migrate";
import { attachEventsWebSocket, getEventBus } from "./events";
import { SettingsRepository } from "./repositories/settings.repository";
import { SettingsService } from "./settings/settings.service";

const port = Number(process.env.PORT) || 3000;

async function main(): Promise<void> {
	if (shouldAutoMigrate()) {
		await runMigrations(pool);
	}

	// Probe ffmpeg for hwaccel backends on boot. Done after migrations so
	// the settings table exists; failure is non-fatal (the resolver falls
	// back to software encoding when the list is empty).
	await bootstrapHwaccelDetection(
		new SettingsService({
			repository: new SettingsRepository(db),
			bus: getEventBus()
		})
	);

	const {
		app,
		scheduler,
		tunersService,
		lineupSyncService,
		epgService,
		epgMatcherService,
		recordingsService,
		seriesRulesService
	} = createAppWithServices();

	// Keep tuner-backed guides in sync before registering recurring refreshes.
	// This also adopts a sole legacy DeviceAuth URL without retaining its token.
	await epgService.reconcileTunerSources(await tunersService.list());
	// Repair stale cross-provider auto-matches as soon as source ownership is known.
	await epgMatcherService.autoMatchUnmapped();
	await epgService.bootstrapScheduling();

	// Check hourly so live settings changes take effect without a restart; the
	// service itself only imports tuners whose configured cadence is due.
	scheduler.registerRecurring({
		name: "tuners:lineup-sync",
		kind: "tuners:lineup-sync",
		cron: "0 * * * *",
		handler: async () => {
			await lineupSyncService.syncDueTuners();
		}
	});

	// Crash recovery for in-flight recordings (rrainn/SignalHaven#R1-oneoff):
	// any rows left in `recording` belong to a previous process so we
	// flip them to `failed` before the scheduler starts dispatching new
	// jobs (otherwise a fresh job for the same row could race recovery).
	await recordingsService.recoverOnStartup();
	// Re-arm any still-`scheduled` recordings whose scheduler rows did
	// not survive the restart (defence-in-depth: cheap idempotent
	// re-registration of a one-off job per row).
	await recordingsService.resumeScheduledOnStartup();

	// Periodic series-rule evaluation (rrainn/SignalHaven#R3-series). We
	// re-register on each boot — recurring jobs are code-defined and
	// live only in memory in the scheduler. The on-EPG-refresh hook in
	// `app.ts` covers freshness; this hourly tick is a safety net.
	scheduler.registerRecurring({
		name: "series-rules:evaluate",
		kind: "series-rules:evaluate",
		cron: "0 * * * *",
		handler: async () => {
			await seriesRulesService.evaluate();
		}
	});

	// Periodic library reconciliation (rrainn/SignalHaven#R4-library): walks
	// the recordings directory once per day to detect missing files,
	// refresh stale `file_size` values, and surface orphan files. The
	// task is idempotent and best-effort — failures are logged but do
	// not affect playback or recording.
	scheduler.registerRecurring({
		name: "recordings:library-scan",
		kind: "recordings:library-scan",
		cron: "0 3 * * *",
		handler: async () => {
			await recordingsService.scanLibrary();
			await recordingsService.enforceStorageQuota();
			await recordingsService.enforceRetention();
		}
	});

	await scheduler.start();

	const server = app.listen(port, () => {
		console.log(`Server listening on port ${port}`);
	});

	const events = attachEventsWebSocket({ server, bus: getEventBus() });

	const shutdown = async (): Promise<void> => {
		await events.close();

		await new Promise<void>((resolve) => {
			server.close(() => {
				resolve();
			});
		});

		await scheduler.shutdown();
		await recordingsService.stopPlaybackSessions();

		await closeDatabasePool(pool);
	};

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			shutdown()
				.catch((error) => {
					console.error("Error during graceful shutdown", error);
					process.exitCode = 1;
				})
				.finally(() => {
					process.exit();
				});
		});
	}
}

main().catch((error) => {
	console.error("Failed to start backend", error);
	process.exitCode = 1;
});
