import { ApiError, errorResponse } from "./errors.ts";
import { parseCall } from "./input.ts";
import { encodeResult } from "./output.ts";
import { PROVIDERS, resolveRoute } from "./routing.ts";
import { evaluate } from "./upstream.ts";
import type { Env, Fetcher } from "./types.ts";

const CORS_HEADERS = "Authorization, Content-Type, X-Bridge-Key, X-Jev-Provider, X-Jev-Endpoint, X-Jev-Preset, X-Jev-Timeout-Ms, X-Jev-Result";

async function bridgeAuth(request: Request, env: Env): Promise<void> {
  if (!env.BRIDGE_API_KEY) return;
  // Fixed-length digest comparison avoids comparing a secret with early-exit ===.
  const encoder = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(request.headers.get("x-bridge-key") ?? "")),
    crypto.subtle.digest("SHA-256", encoder.encode(env.BRIDGE_API_KEY)),
  ]);
  const a = new Uint8Array(actual), b = new Uint8Array(expected);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  if (difference !== 0) throw new ApiError(401, "invalid_bridge_key", "Missing or invalid X-Bridge-Key.");
}

export async function handleRequest(request: Request, env: Env = {}, fetcher: Fetcher = fetch): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  const origin = request.headers.get("origin");
  const corsAllowed = origin !== null && origin !== "null" && (env.CORS_ORIGINS ?? "").split(",").map((x) => x.trim()).includes(origin);
  let response: Response;
  try {
    if (request.method === "OPTIONS") {
      if (!corsAllowed) throw new ApiError(403, "origin_not_allowed", "Browser origin is not allowed.");
      response = new Response(null, { status: 204 });
    } else {
      const path = new URL(request.url).pathname;
      if (path === "/health" && request.method === "GET") {
        response = Response.json({ status: "ok", version: "0.1.0" });
      } else {
        await bridgeAuth(request, env);
        if (path === "/v1/models" && request.method === "GET") {
          response = Response.json({ object: "list", data: Object.entries(PROVIDERS).flatMap(([provider, config]) => config.models.map((id) => ({ id, object: "model", created: 0, owned_by: provider }))) });
        } else if (path === "/v1/chat/completions" || path === "/v1/responses") {
          if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Use POST for this endpoint.");
          const call = await parseCall(request, path === "/v1/chat/completions" ? "chat" : "responses");
          const route = resolveRoute(request.headers, call.apiKey, env);
          const result = await evaluate(call, route, request.signal, fetcher);
          response = encodeResult(call, route, result, requestId);
        } else throw new ApiError(404, "not_found", "Endpoint not found.");
      }
    }
  } catch (error) { response = errorResponse(error, requestId); }
  response.headers.set("x-request-id", requestId);
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("vary", "Origin");
  if (response.status === 405) response.headers.set("allow", "POST");
  if (corsAllowed) {
    response.headers.set("access-control-allow-origin", origin!);
    response.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
    response.headers.set("access-control-allow-headers", CORS_HEADERS);
    response.headers.set("access-control-expose-headers", "X-Request-Id, X-Jev-Provider, Retry-After");
    response.headers.set("access-control-max-age", "600");
  }
  return response;
}

export default { fetch: (request: Request, env: Env) => handleRequest(request, env) };
