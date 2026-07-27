import { randomUUID } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

export const REQUEST_ID_HEADER = "x-request-id";

declare module "express-serve-static-core" {
	interface Request {
		id: string;
	}
}

export function requestId() {
	return (req: Request, res: Response, next: NextFunction): void => {
		const headerValue = req.header(REQUEST_ID_HEADER);
		const id =
			typeof headerValue === "string" && headerValue.length > 0
				? headerValue
				: randomUUID();

		req.id = id;
		res.setHeader(REQUEST_ID_HEADER, id);
		next();
	};
}
