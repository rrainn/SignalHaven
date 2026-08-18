import type { ErrorBody } from "@signalhaven/shared";
import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details?: unknown;
	/** Internal marker excluded from serialized error diagnostics. */
	declare readonly diagnosticLogged: boolean;

	constructor(
		status: number,
		code: string,
		message: string,
		details?: unknown,
		/** True when a service already emitted the actionable terminal cause. */
		diagnosticLogged = false
	) {
		super(message);
		this.name = "HttpError";
		this.status = status;
		this.code = code;
		Object.defineProperty(this, "diagnosticLogged", {
			value: diagnosticLogged,
			enumerable: false
		});
		if (details !== undefined) {
			this.details = details;
		}
	}
}

export function notFound(message = "Not Found"): HttpError {
	return new HttpError(404, "not_found", message);
}

export function badRequest(message: string, details?: unknown): HttpError {
	return new HttpError(400, "bad_request", message, details);
}

export function unauthorized(message = "Authentication required"): HttpError {
	return new HttpError(401, "unauthorized", message);
}

export function forbidden(
	message = "Administrator access required"
): HttpError {
	return new HttpError(403, "forbidden", message);
}

export function conflict(message: string): HttpError {
	return new HttpError(409, "conflict", message);
}

export function notFoundHandler(
	_req: Request,
	_res: Response,
	next: NextFunction
): void {
	next(notFound());
}

interface ErrorEnvelope {
	error: ErrorBody;
}

function toErrorBody(
	err: unknown,
	requestId: string
): { status: number; body: ErrorEnvelope } {
	if (err instanceof HttpError) {
		const body: ErrorBody = {
			code: err.code,
			message: err.message,
			requestId
		};
		if (err.details !== undefined) {
			body.details = err.details;
		}
		return { status: err.status, body: { error: body } };
	}

	if (err instanceof ZodError) {
		return {
			status: 400,
			body: {
				error: {
					code: "validation_error",
					message: "Request validation failed",
					details: err.issues,
					requestId
				}
			}
		};
	}

	return {
		status: 500,
		body: {
			error: {
				code: "internal_server_error",
				message: "Internal Server Error",
				requestId
			}
		}
	};
}

export function errorHandler(onError?: ((err: unknown) => void) | undefined) {
	return (
		err: unknown,
		req: Request,
		res: Response,
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		_next: NextFunction
	): void => {
		const requestId = req.id;
		const { status, body } = toErrorBody(err, requestId);

		if (status >= 500 && req.log && !isDiagnosticLogged(err)) {
			req.log.error({ err, requestId }, "Unhandled error");
		} else if (req.log && !isDiagnosticLogged(err)) {
			req.log.warn({ err, requestId, status }, "Request failed");
		}

		if (status >= 500 && onError) {
			onError(err);
		}

		if (res.headersSent) {
			res.end();
			return;
		}

		res.status(status).json(body);
	};
}

/** Avoid repeating a generic wrapper after its safe terminal cause was logged. */
function isDiagnosticLogged(error: unknown): boolean {
	return error instanceof HttpError && error.diagnosticLogged;
}
