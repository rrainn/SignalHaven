import "../zod-openapi-setup";

import { z } from "zod";

export const healthResponseSchema = z.object({
	status: z.enum(["ok", "error"]),
	version: z.string(),
	uptime: z.number().nonnegative(),
	db: z.object({
		ok: z.boolean()
	})
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
