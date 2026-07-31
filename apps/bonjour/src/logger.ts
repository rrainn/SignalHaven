/** JSON values accepted by the sidecar's structured stdout logger. */
export type LogFields = Record<string, boolean | number | string | undefined>;

/** Emits compact structured events for container log aggregation. */
export function logEvent(event: string, fields: LogFields = {}): void {
	console.log(
		JSON.stringify({
			timestamp: new Date().toISOString(),
			event,
			...fields
		})
	);
}

/** Converts unknown failures into safe diagnostic text. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
