import {
	searchQuerySchema,
	searchResponseSchema,
	type SearchQuery
} from "@signalhaven/shared";
import { Router } from "express";

import { validate } from "../middleware/validate";
import type { SearchService } from "../../search/search.service";

/**
 * Global search endpoint (rrainn/SignalHaven#U10-search).
 *
 *   * `GET /api/v1/search?q=…&limit=…` — returns a `{ channels,
 *     programs, recordings }` triple. Per-group cap controlled by
 *     `limit` (default 10, max 25). All inputs are validated +
 *     parameter-bound before they reach the database.
 */
export function createSearchRouter(service: SearchService): Router {
	const router = Router();

	router.get(
		"/search",
		validate({ query: searchQuerySchema }),
		async (req, res, next) => {
			try {
				// Guide refreshes can remove results at any time, so intermediaries must
				// not reuse a response after its underlying program has disappeared.
				res.setHeader("Cache-Control", "no-store");
				const query = req.query as unknown as SearchQuery;
				const result = await service.search({
					q: query.q,
					limit: query.limit
				});
				res.json(searchResponseSchema.parse(result));
			} catch (error) {
				next(error);
			}
		}
	);

	return router;
}
