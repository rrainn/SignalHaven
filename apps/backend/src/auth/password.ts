import {
	randomBytes,
	scrypt as nodeScrypt,
	timingSafeEqual
} from "node:crypto";

import { passwordSchema } from "@signalhaven/shared";

import { HttpError } from "../http/middleware/errors";

const KEY_LENGTH = 64;
const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
/** Scrypt is memory-hard; keep concurrent work below a small host-safe ceiling. */
export const MAX_CONCURRENT_PASSWORD_WORK = 4;
let activePasswordWork = 0;

/** Derive a password key without blocking the Node.js event loop. */
function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
	if (activePasswordWork >= MAX_CONCURRENT_PASSWORD_WORK) {
		return Promise.reject(
			new HttpError(
				429,
				"authentication_busy",
				"Authentication is busy; try again shortly"
			)
		);
	}
	activePasswordWork += 1;
	return new Promise((resolve, reject) => {
		nodeScrypt(
			password,
			salt,
			KEY_LENGTH,
			{
				N: COST,
				r: BLOCK_SIZE,
				p: PARALLELIZATION,
				maxmem: 64 * 1024 * 1024
			},
			(error, derivedKey) => {
				activePasswordWork -= 1;
				if (error) {
					reject(error);
					return;
				}
				resolve(derivedKey);
			}
		);
	});
}

/** Store the parameters with each salt so later cost upgrades stay possible. */
export async function hashPassword(password: string): Promise<string> {
	passwordSchema.parse(password);
	const salt = randomBytes(16);
	const derivedKey = await deriveKey(password, salt);

	return [
		"scrypt",
		"v=1",
		String(COST),
		String(BLOCK_SIZE),
		String(PARALLELIZATION),
		salt.toString("base64url"),
		derivedKey.toString("base64url")
	].join("$");
}

/** Malformed or obsolete hashes fail closed instead of surfacing parse errors. */
export async function verifyPassword(
	password: string,
	encoded: string
): Promise<boolean> {
	const [algorithm, version, cost, blockSize, parallelization, salt, expected] =
		encoded.split("$");
	if (
		algorithm !== "scrypt" ||
		version !== "v=1" ||
		cost !== String(COST) ||
		blockSize !== String(BLOCK_SIZE) ||
		parallelization !== String(PARALLELIZATION) ||
		!salt ||
		!expected
	) {
		return false;
	}

	try {
		const expectedKey = Buffer.from(expected, "base64url");
		const actualKey = await deriveKey(password, Buffer.from(salt, "base64url"));
		return (
			expectedKey.length === actualKey.length &&
			timingSafeEqual(expectedKey, actualKey)
		);
	} catch (error) {
		if (error instanceof HttpError) throw error;
		return false;
	}
}
