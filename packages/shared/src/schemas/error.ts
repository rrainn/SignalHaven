import "../zod-openapi-setup";

import { z } from "zod";

export const errorBodySchema = z.object({
	code: z.string(),
	message: z.string(),
	details: z.unknown().optional(),
	requestId: z.string().optional()
});

export const errorResponseSchema = z.object({
	error: errorBodySchema
});

export type ErrorBody = z.infer<typeof errorBodySchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
