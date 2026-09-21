import { ApiError } from "./errors.ts";
import { readBounded, record } from "./input.ts";
import type { Call, Decision, DecisionResult, Fetcher, Route } from "./types.ts";

function malformed(): never {
  throw new ApiError(502, "invalid_upstream_response", "Upstream returned an invalid decision response.");
}
function probability(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
export function validateResult(value: unknown, decision: Decision): DecisionResult {
  if (!record(value) || typeof value.model !== "string" || !value.model || !record(value.answers) || !record(value.usage)) malformed();
  for (const key of ["input_tokens", "output_tokens"]) {
    if (!Number.isSafeInteger(value.usage[key]) || (value.usage[key] as number) < 0) malformed();
  }
  if (Object.keys(value.answers).length !== Object.keys(decision.questions).length) malformed();
  for (const [id, q] of Object.entries(decision.questions)) {
    const a = Object.hasOwn(value.answers, id) ? value.answers[id] : undefined;
    if (!record(a) || a.type !== q.type) malformed();
    if (a.confidence !== undefined && !probability(a.confidence)) malformed();
    if (q.type === "noul" && !probability(a.noul)) malformed();
    if (q.type === "choice" && (typeof a.choice !== "string" || !Object.hasOwn(q.criteria, a.choice))) malformed();
    if (q.type === "score" && (typeof a.score !== "number" || !Number.isFinite(a.score) || a.score < 0 || a.score > q.criteria.length - 1)) malformed();
    if (a.probabilities !== undefined) {
      if (!record(a.probabilities) || !Object.values(a.probabilities).every(probability)) malformed();
      const expected = q.type === "choice" ? Object.keys(q.criteria) : q.type === "score" ? q.criteria.map((_, i) => String(i)) : undefined;
      if (expected && (Object.keys(a.probabilities).length !== expected.length || expected.some((key) => !Object.hasOwn(a.probabilities as object, key)))) malformed();
    }
  }
  return value as unknown as DecisionResult;
}

export async function evaluate(call: Call, route: Route, signal: AbortSignal, fetcher: Fetcher): Promise<DecisionResult> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, route.timeoutMs);
  try {
    if (signal.aborted) throw new ApiError(499, "request_cancelled", "Client cancelled the request.");
    const response = await fetcher(route.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json", "authorization": `Bearer ${call.apiKey}` },
      body: JSON.stringify({ model: call.model, state: call.decision.state, questions: call.decision.questions }),
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const status = response.status;
      const retryAfter = response.headers.get("retry-after");
      // Never echo upstream error bodies: some gateways reflect request headers.
      const messages: Record<number, string> = {
        401: "Upstream rejected the API key.", 402: "Upstream credits are exhausted.",
        403: "Upstream denied access.", 429: "Upstream rate limit exceeded.",
      };
      const mapped = status >= 300 && status < 400 ? 502 : status === 529 ? 503 : status === 524 ? 504 : status;
      throw new ApiError(mapped, `upstream_${status}`, messages[status] ?? `Upstream request failed (HTTP ${status}).`, null,
        retryAfter && /^(?:\d{1,8}|[A-Za-z]{3}, .{20,40} GMT)$/.test(retryAfter) ? retryAfter : undefined);
    }
    let value: unknown;
    try { value = JSON.parse(await readBounded(response.body, 1048576)); }
    catch (e) { if (controller.signal.aborted) throw e; malformed(); }
    return validateResult(value, call.decision);
  } catch (error) {
    if (timedOut) throw new ApiError(504, "upstream_timeout", "Upstream request timed out.");
    if (signal.aborted) throw new ApiError(499, "request_cancelled", "Client cancelled the request.");
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "upstream_unreachable", "Could not reach the upstream endpoint.");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}
