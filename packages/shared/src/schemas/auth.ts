import "../zod-openapi-setup";

import { z } from "zod";

/** Roles intentionally stay small so authorization decisions remain auditable. */
export const userRoleSchema = z.enum(["admin", "user"]);

export type UserRole = z.infer<typeof userRoleSchema>;

/** Public account identity; password material never crosses this boundary. */
export const userSchema = z.object({
	id: z.string().uuid(),
	username: z.string(),
	role: userRoleSchema
});

export type User = z.infer<typeof userSchema>;

/** Usernames are deliberately local-only identifiers, not email addresses. */
export const usernameSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(/^[\p{L}\p{N}._-]+$/u, {
		message: "Use letters, numbers, periods, underscores, or hyphens"
	});

/** Password bounds prevent accidental empty values and abusive scrypt inputs. */
export const passwordSchema = z.string().min(8).max(128);

export const authTransportSchema = z.enum(["cookie", "bearer"]);

const authIdentitySchema = z.object({
	username: usernameSchema,
	transport: authTransportSchema
});

export const authSetupSchema = authIdentitySchema.extend({
	password: passwordSchema
});
export type AuthSetup = z.infer<typeof authSetupSchema>;

/** Login accepts short wrong guesses so authentication failures remain generic. */
export const authLoginSchema = authIdentitySchema.extend({
	password: z.string().min(1).max(128)
});
export type AuthLogin = z.infer<typeof authLoginSchema>;

/** Backwards-friendly name for clients building the initial account form. */
export const authCredentialsSchema = authSetupSchema;

export const authSessionSchema = z.object({
	user: userSchema,
	token: z.string().nullable(),
	expiresAt: z.string().datetime()
});

export type AuthSession = z.infer<typeof authSessionSchema>;

export const authStatusSchema = z.object({
	requiresInitialAdmin: z.boolean(),
	systemSetupRequired: z.boolean(),
	user: userSchema.nullable()
});

export type AuthStatus = z.infer<typeof authStatusSchema>;

export const authMeSchema = z.object({
	user: userSchema
});

export type AuthMe = z.infer<typeof authMeSchema>;

export const userCreateSchema = z.object({
	username: usernameSchema,
	password: passwordSchema
});

export type UserCreate = z.infer<typeof userCreateSchema>;

export const userListSchema = z.object({
	users: z.array(userSchema)
});

export type UserList = z.infer<typeof userListSchema>;

/** A media ticket hides the opaque secret inside a ready-to-play relative URL. */
export const mediaTicketSchema = z.object({
	playbackPath: z.string().startsWith("/api/v1/"),
	expiresAt: z.string().datetime()
});

export type MediaTicket = z.infer<typeof mediaTicketSchema>;

/** Live playback choices are bound into the ticket instead of trusted later. */
export const liveMediaTicketRequestSchema = z.object({
	viewerId: z.string().uuid().optional(),
	profile: z
		.enum([
			"auto",
			"direct",
			"original-quality",
			"1080p",
			"720p",
			"480p",
			"audio-only"
		])
		.optional()
});

export type LiveMediaTicketRequest = z.infer<
	typeof liveMediaTicketRequestSchema
>;

/** Recording resume offsets are likewise frozen into the issued playback URL. */
export const recordingMediaTicketRequestSchema = z.object({
	viewerId: z.string().uuid().optional(),
	start: z.number().int().min(0).optional()
});

export type RecordingMediaTicketRequest = z.infer<
	typeof recordingMediaTicketRequestSchema
>;
