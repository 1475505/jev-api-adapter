import { handleRequest } from "./index.ts";

// Pin the route in each entrypoint: Vercel may expose the rewritten /api URL.
export function vercelHandler(path: string) {
  return {
    fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      url.pathname = path;
      return handleRequest(new Request(url, request), {
        BRIDGE_API_KEY: process.env.BRIDGE_API_KEY,
        ALLOWED_UPSTREAM_ORIGINS: process.env.ALLOWED_UPSTREAM_ORIGINS,
        CORS_ORIGINS: process.env.CORS_ORIGINS,
      });
    },
  };
}
