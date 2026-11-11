import type { Config } from "./config.ts";
import type { RateLimiter } from "./limiter.ts";

export interface Request {
  clientId: string;
  path: string;
}

export interface Response {
  status: number;
  body: string;
}

/** Build the request handler. `settings` is called on every request. */
export function createHandler(settings: () => Config, limiter: RateLimiter): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!limiter.allow(request.clientId)) return { status: 429, body: "slow down" };
    const { features } = settings();
    if (request.path === "/search" && !features.search) return { status: 404, body: "not found" };
    if (request.path === "/export" && !features.export) return { status: 404, body: "not found" };
    return { status: 200, body: `ok ${request.path}` };
  };
}
