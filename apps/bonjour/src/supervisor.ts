/** A live DNS-SD registration that can send its goodbye announcement. */
export interface AdvertisementRegistration {
	stop(): Promise<void>;
}

/** Creates one registration after the application becomes healthy. */
export type AdvertisementFactory = () => Promise<AdvertisementRegistration>;

/** Keeps discovery synchronized with health without allowing lifecycle races. */
export class AdvertisementSupervisor {
	private registration: AdvertisementRegistration | undefined;
	private operation: Promise<void> = Promise.resolve();

	public constructor(private readonly create: AdvertisementFactory) {}

	/** Applies the latest observed health state in observation order. */
	public reconcile(healthy: boolean): Promise<void> {
		return this.enqueue(async () => {
			if (healthy && !this.registration) {
				this.registration = await this.create();
				return;
			}

			if (!healthy && this.registration) {
				const registration = this.registration;
				this.registration = undefined;
				await registration.stop();
			}
		});
	}

	/** Withdraws any active advertisement during graceful shutdown. */
	public stop(): Promise<void> {
		return this.reconcile(false);
	}

	/** Serializes async transitions so delayed registration cannot beat withdrawal. */
	private enqueue(operation: () => Promise<void>): Promise<void> {
		const result = this.operation.then(operation);
		this.operation = result.catch(() => undefined);
		return result;
	}
}
