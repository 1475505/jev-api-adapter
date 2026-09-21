import { ApiError, invalid } from "./errors.ts";
import type { Env, Provider, Route } from "./types.ts";

export const PROVIDERS: Record<Provider, { endpoint: string; models: string[] }> = {
  typesafe: { endpoint: "https://api.typesafe.ai/v1/systemone", models: ["jev-latest", "jev-1.13.0"] },
  vercel: { endpoint: "https://ai-gateway.vercel.sh/typesafe/v1/systemone", models: ["typesafe-ai/jev"] },
  // The operation-level OpenAPI server overrides /api/v1. Do not prepend it.
  openrouter: { endpoint: "https://openrouter.ai/api/alpha/decisions", models: ["typesafe/jev-1.13"] },
};
export function keyProvider(key: string): Provider | undefined {
  // Public OpenRouter OpenAPI examples establish this prefix. Other keys are
  // deliberately opaque: never send credentials to multiple APIs to probe them.
  if (key.startsWith("sk-or-v1-") && key.length > "sk-or-v1-".length) return "openrouter";
}
function provider(value: string): Provider {
  if (!Object.hasOwn(PROVIDERS, value)) invalid("Provider must be typesafe, vercel, or openrouter.", "X-Jev-Provider");
  return value as Provider;
}
function knownOrigin(origin: string): Provider | undefined {
  return (Object.keys(PROVIDERS) as Provider[]).find((p) => new URL(PROVIDERS[p].endpoint).origin === origin);
}
function endpointURL(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { invalid("Endpoint must be an absolute HTTPS URL.", "X-Jev-Endpoint"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || (url.port && url.port !== "443")) invalid("Endpoint requires HTTPS on port 443 without credentials, query, or fragment.", "X-Jev-Endpoint");
  // Only deployment-owner-trusted DNS names can be added below. Block literal
  // IPs and local names even if accidentally included in the allowlist.
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".") || host.includes(":") || /^[\d.]+$/.test(host)
    || /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid)$/.test(host)) {
    invalid("Endpoint must use a public DNS hostname.", "X-Jev-Endpoint");
  }
  return url;
}
function allowedOrigin(origin: string, env: Env): boolean {
  if (knownOrigin(origin)) return true;
  return (env.ALLOWED_UPSTREAM_ORIGINS ?? "").split(",").some((entry) => entry.trim() === origin);
}

export function resolveRoute(headers: Headers, apiKey: string, env: Env): Route {
  const explicit = headers.get("x-jev-provider");
  const endpoint = headers.get("x-jev-endpoint");
  const url = endpoint !== null ? endpointURL(endpoint) : undefined;
  const originHint = url ? knownOrigin(url.origin) : undefined;
  const keyHint = keyProvider(apiKey);
  const selected = explicit !== null ? provider(explicit) : originHint ?? keyHint;
  if (!selected) invalid("Cannot infer provider; set X-Jev-Provider.", "X-Jev-Provider");
  if (originHint && originHint !== selected) invalid("Provider conflicts with the official endpoint origin.", "X-Jev-Provider");
  if (keyHint && keyHint !== selected) invalid("Provider conflicts with the recognized API key prefix.", "X-Jev-Provider");
  if (url && !allowedOrigin(url.origin, env)) throw new ApiError(403, "endpoint_not_allowed", "Endpoint origin is not in ALLOWED_UPSTREAM_ORIGINS.", "X-Jev-Endpoint");
  // Official origins only accept the verified native decision path. Custom
  // origins may use any full path under the explicitly trusted origin.
  if (url && originHint && url.href !== PROVIDERS[originHint].endpoint) invalid("Use the provider's native decision endpoint, not its chat or evaluation endpoint.", "X-Jev-Endpoint");
  const timeout = headers.get("x-jev-timeout-ms") ?? "10000";
  if (!/^\d+$/.test(timeout) || Number(timeout) < 100 || Number(timeout) > 60000) invalid("Timeout must be an integer between 100 and 60000 ms.", "X-Jev-Timeout-Ms");
  const result = headers.get("x-jev-result") ?? "answers";
  if (result !== "answers" && result !== "full") invalid("Result must be answers or full.", "X-Jev-Result");
  return { provider: selected, endpoint: url?.href ?? PROVIDERS[selected].endpoint, timeoutMs: Number(timeout), result };
}
