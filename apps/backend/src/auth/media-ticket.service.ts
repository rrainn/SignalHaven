import type { AuthPrincipal } from "./auth.service";
import { createOpaqueToken, hashOpaqueToken } from "./session-token";
import type {
	MediaResourceKind,
	MediaTicketsRepository
} from "../repositories/media-tickets.repository";

export const MEDIA_TICKET_DURATION_MS = 12 * 60 * 60 * 1_000;
/** Limits bound bearer-capability storage even across concurrent native calls. */
export const MEDIA_TICKETS_PER_SESSION = 32;
export const MEDIA_TICKETS_PER_USER = 64;

export interface MediaResourceScope {
	kind: MediaResourceKind;
	id: string;
}

export type MediaTicketScope =
	| (MediaResourceScope & {
			kind: "live";
			claims: { profile: string; viewerId?: string };
	  })
	| (MediaResourceScope & {
			kind: "recording";
			claims: { start: number; viewerId?: string };
	  });

export class MediaTicketService {
	constructor(
		private readonly repository: Pick<
			MediaTicketsRepository,
			"createBounded" | "findActive"
		>
	) {}

	async issue(
		principal: AuthPrincipal,
		resource: MediaTicketScope
	): Promise<{ token: string; expiresAt: Date }> {
		const token = createOpaqueToken();
		const expiresAt = new Date(Date.now() + MEDIA_TICKET_DURATION_MS);
		await this.repository.createBounded(
			{
				tokenHash: hashOpaqueToken(token),
				sessionId: principal.sessionId,
				userId: principal.user.id,
				resourceKind: resource.kind,
				resourceId: resource.id,
				claims: resource.claims,
				expiresAt
			},
			{
				perSession: MEDIA_TICKETS_PER_SESSION,
				perUser: MEDIA_TICKETS_PER_USER
			}
		);
		return { token, expiresAt };
	}

	async authenticate(
		token: string,
		resource: MediaResourceScope,
		requestUrl: URL
	): Promise<AuthPrincipal | null> {
		if (token.length < 32 || token.length > 256) return null;
		const row = await this.repository.findActive({
			tokenHash: hashOpaqueToken(token),
			resourceKind: resource.kind,
			resourceId: resource.id
		});
		if (!row) return null;
		if (!claimsMatchRequest(resource.kind, row.claims, requestUrl)) return null;
		return {
			sessionId: row.sessionId,
			user: {
				id: row.userId,
				username: row.username,
				role: row.role
			}
		};
	}
}

/** Ticket options are immutable while session/artifact query values may vary. */
function claimsMatchRequest(
	kind: MediaResourceKind,
	claims: Record<string, unknown>,
	requestUrl: URL
): boolean {
	const requestedViewer = requestUrl.searchParams.get("viewerId") ?? undefined;
	const claimedViewer =
		typeof claims["viewerId"] === "string" ? claims["viewerId"] : undefined;
	if (requestedViewer !== claimedViewer) return false;
	if (kind === "live") {
		return (
			typeof claims["profile"] === "string" &&
			requestUrl.searchParams.get("profile") === claims["profile"]
		);
	}
	const requestedStart = requestUrl.searchParams.get("start");
	if (requestedStart === null) {
		// Nested recording artifacts intentionally omit the manifest-only offset.
		return !requestUrl.pathname.endsWith("/stream.m3u8");
	}
	return (
		typeof claims["start"] === "number" &&
		Number(requestedStart) === claims["start"]
	);
}

/** Only HLS playlists and artifacts may exchange a media ticket for access. */
export function resolveMediaResource(path: string): MediaResourceScope | null {
	const live =
		/^\/stream\/([^/]+)\/(?:master\.m3u8|playlist\.m3u8|captions\.m3u8|segments\/[^/]+|variants\/[^/]+\/(?:playlist\.m3u8|segments\/[^/]+))$/.exec(
			path
		);
	if (live?.[1]) {
		try {
			return { kind: "live", id: decodeURIComponent(live[1]) };
		} catch {
			return null;
		}
	}
	const recording =
		/^\/recordings\/([0-9a-f-]{36})\/(?:stream\.m3u8|segments\/[^/]+)$/.exec(
			path
		);
	return recording?.[1] ? { kind: "recording", id: recording[1] } : null;
}
