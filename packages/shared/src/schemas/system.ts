import "../zod-openapi-setup";

import { z } from "zod";

/** Public build and runtime metadata shown in the Settings About tab. */
export const systemInfoSchema = z.object({
	version: z.string().min(1),
	gitCommit: z.string().min(1),
	uptime: z.number().nonnegative()
});

export type SystemInfo = z.infer<typeof systemInfoSchema>;
