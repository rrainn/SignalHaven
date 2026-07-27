import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodType } from "zod";

import { badRequest } from "./errors";

interface ValidateOptions<
	TBody extends ZodType | undefined,
	TQuery extends ZodType | undefined,
	TParams extends ZodType | undefined
> {
	body?: TBody;
	query?: TQuery;
	params?: TParams;
}

export function validate<
	TBody extends ZodType | undefined = undefined,
	TQuery extends ZodType | undefined = undefined,
	TParams extends ZodType | undefined = undefined
>(schemas: ValidateOptions<TBody, TQuery, TParams>): RequestHandler {
	return (req: Request, _res: Response, next: NextFunction): void => {
		if (schemas.body) {
			const result = schemas.body.safeParse(req.body);
			if (!result.success) {
				next(
					badRequest("Invalid request body", { issues: result.error.issues })
				);
				return;
			}
			req.body = result.data;
		}

		if (schemas.query) {
			const result = schemas.query.safeParse(req.query);
			if (!result.success) {
				next(
					badRequest("Invalid query parameters", {
						issues: result.error.issues
					})
				);
				return;
			}
			// Express 5's req.query getter is read-only; assign via descriptor.
			Object.defineProperty(req, "query", {
				value: result.data,
				writable: true,
				configurable: true
			});
		}

		if (schemas.params) {
			const result = schemas.params.safeParse(req.params);
			if (!result.success) {
				next(
					badRequest("Invalid path parameters", {
						issues: result.error.issues
					})
				);
				return;
			}
			Object.defineProperty(req, "params", {
				value: result.data,
				writable: true,
				configurable: true
			});
		}

		next();
	};
}
