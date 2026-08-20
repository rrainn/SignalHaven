import { createHash, randomBytes } from "node:crypto";

/** Opaque tokens carry no account data, so revocation is always authoritative. */
export function createOpaqueToken(): string {
	return randomBytes(32).toString("base64url");
}

/** Database exposure cannot turn stored digests back into bearer credentials. */
export function hashOpaqueToken(token: string): string {
	return createHash("sha256").update(token).digest("base64url");
}
