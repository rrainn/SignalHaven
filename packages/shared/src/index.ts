import "./zod-openapi-setup";

import { z } from "zod";

export const helloResponseSchema = z.object({
	message: z.string()
});

export type HelloResponse = z.infer<typeof helloResponseSchema>;

export * from "./schemas/error";
export * from "./schemas/events";
export * from "./schemas/health";
export * from "./schemas/settings";
export * from "./schemas/system";
export * from "./schemas/tuners";
export * from "./schemas/epg";
export * from "./schemas/epg-grid";
export * from "./schemas/channels";
export * from "./schemas/channel-list";
export * from "./schemas/recordings";
export * from "./schemas/search";
export * from "./schemas/series-rules";
export * from "./schemas/advanced";
export * from "./schemas/playback";
