import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI from "openai";
import { handleRequest } from "../src/index.ts";
import { PROVIDERS } from "../src/routing.ts";
import type { Decision, Env, Fetcher, Provider } from "../src/types.ts";

const decision: Decision = {
  state: "订单重复扣款，请尽快退款。",
  questions: {
    refund: { type: "noul", instructions: "是否请求退款？" },
    team: { type: "choice", instructions: "交给谁处理？", criteria: { billing: null, other: "Other" } },
    urgency: { type: "score", instructions: "有多紧急？", criteria: ["low", "medium", "high"] },
  },
};
const result = {
  model: "jev-1.13.0",
  answers: {
    refund: { type: "noul", noul: 0.97 },
    team: { type: "choice", choice: "billing", probabilities: { billing: 0.9, other: 0.1 }, confidence: 0.6 },
    urgency: { type: "score", score: 1.3, probabilities: { "0": 0.1, "1": 0.5, "2": 0.4 }, confidence: 0.3, legend: { "0": "low", "1": "medium", "2": "high" } },
  },
  usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
};
function body(extra: Record<string, unknown> = {}) {
  return { model: "jev-1.13.0", api_key: "test-key", messages: [{ role: "user", content: JSON.stringify(decision) }], ...extra };
}
function request(value: unknown = body(), headers: Record<string, string> = {}, path = "/v1/chat/completions", signal?: AbortSignal) {
  return new Request(`https://bridge.example.com${path}`, { method: "POST", headers: { "content-type": "application/json", "x-jev-provider": "typesafe", ...headers }, body: JSON.stringify(value), signal });
}
const good: Fetcher = async () => Response.json(result);
const forbidden: Fetcher = async () => { throw new Error("unexpected upstream call"); };
async function errorCode(req: Request, code: string, status: number, env: Env = {}) {
  let called = false;
  const response = await handleRequest(req, env, async () => { called = true; return Response.json(result); });
  assert.equal(called, false);
  assert.equal(response.status, status);
  assert.equal((await response.json() as any).error.code, code);
}

for (const provider of Object.keys(PROVIDERS) as Provider[]) {
  test(`${provider}: exact URL, model, key and decision passthrough`, async () => {
    let calls = 0;
    const model = PROVIDERS[provider].models[0];
    const key = provider === "openrouter" ? "sk-or-v1-example" : "opaque-provider-key";
    const response = await handleRequest(request(body({ model, api_key: key }), { "x-jev-provider": provider, "x-bridge-key": "bridge-only" }), { BRIDGE_API_KEY: "bridge-only" }, async (url, init) => {
      calls++;
      assert.equal(url, PROVIDERS[provider].endpoint);
      assert.equal(init?.redirect, "manual");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${key}`);
      assert.equal(headers.has("x-bridge-key"), false);
      assert.deepEqual(JSON.parse(init?.body as string), { model, ...decision });
      return Response.json(result);
    });
    assert.equal(calls, 1);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-jev-provider"), provider);
    const data = await response.json() as any;
    assert.deepEqual(JSON.parse(data.choices[0].message.content), result.answers);
    assert.deepEqual(data.usage, { prompt_tokens: 476, completion_tokens: 70, total_tokens: 546 });
  });
}

test("route by OpenRouter prefix without any provider header", async () => {
  const req = request(body({ api_key: "sk-or-v1-example" }));
  req.headers.delete("x-jev-provider");
  const response = await handleRequest(req, {}, async (url) => {
    assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
    return Response.json(result);
  });
  assert.equal(response.status, 200);
});
test("opaque key requires provider instead of probing", async () => {
  const req = request(); req.headers.delete("x-jev-provider");
  await errorCode(req, "invalid_request", 400);
});
test("route by official endpoint and reject contradictory provider/key", async () => {
  const req = request(body(), { "x-jev-endpoint": PROVIDERS.vercel.endpoint });
  req.headers.delete("x-jev-provider");
  const response = await handleRequest(req, {}, async (url) => {
    assert.equal(url, PROVIDERS.vercel.endpoint); return Response.json(result);
  });
  assert.equal(response.status, 200);
  await errorCode(request(body(), { "x-jev-endpoint": PROVIDERS.vercel.endpoint }), "invalid_request", 400);
  await errorCode(request(body({ api_key: "sk-or-v1-example" })), "invalid_request", 400);
});
test("full custom endpoint must be trusted and is used without appending a path", async () => {
  const headers = { "x-jev-endpoint": "https://gateway.example.com/custom/decisions" };
  await errorCode(request(body(), headers), "endpoint_not_allowed", 403);
  const response = await handleRequest(request(body(), headers), { ALLOWED_UPSTREAM_ORIGINS: "https://gateway.example.com" }, async (url) => {
    assert.equal(url, headers["x-jev-endpoint"]); return Response.json(result);
  });
  assert.equal(response.status, 200);
});
for (const endpoint of ["http://gateway.example.com/x", "https://127.0.0.1/x", "https://2130706433/x", "https://[::1]/x", "https://metadata.internal/x", "https://localhost/x", "https://a:b@gateway.example.com/x", "https://gateway.example.com:8443/x", "https://gateway.example.com/x?key=secret", "https://gateway.example.com/x#fragment", "https://openrouter.ai/api/v1/chat/completions"]) {
  test(`reject unsafe or wrong endpoint: ${endpoint}`, async () => {
    await errorCode(request(body(), { "x-jev-endpoint": endpoint }), "invalid_request", 400);
  });
}
test("body/auth keys must match; bridge secret is separate", async () => {
  await errorCode(request(body(), { authorization: "Bearer another-key" }), "invalid_request", 400);
  await errorCode(request(body(), { authorization: "Basic example" }), "invalid_request", 400);
  await errorCode(request(body({ api_key: undefined })), "missing_api_key", 401);
  await errorCode(request(), "invalid_bridge_key", 401, { BRIDGE_API_KEY: "secret" });
  const response = await handleRequest(request(body({ api_key: undefined }), { authorization: "Bearer sdk-key" }), {}, async (_, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sdk-key"); return Response.json(result);
  });
  assert.equal(response.status, 200);
});
test("preset accepts natural language without JSON parsing", async () => {
  const req = request(body({ messages: [{ role: "user", content: "太棒了！" }] }), { "x-jev-preset": "sentiment-v1" });
  const response = await handleRequest(req, {}, async (_, init) => {
    const payload = JSON.parse(init?.body as string);
    assert.equal(payload.state, "太棒了！");
    assert.equal(payload.questions.sentiment.type, "choice");
    return Response.json({ model: "jev-latest", answers: { sentiment: { type: "choice", choice: "positive" } }, usage: { input_tokens: 10, output_tokens: 2 } });
  });
  assert.equal(response.status, 200);
});
test("full result retains vendor metadata", async () => {
  const response = await handleRequest(request(body(), { "x-jev-result": "full" }), {}, good);
  const data = await response.json() as any;
  assert.deepEqual(JSON.parse(data.choices[0].message.content), result);
});
test("structured state/instructions are preserved", async () => {
  const payload = structuredClone(decision);
  payload.state = { customer: { message: "退款", tags: ["vip"] } };
  payload.questions.refund.instructions = { question: "是否退款？", policy: ["double charge"] };
  const response = await handleRequest(request(body({ messages: [{ role: "user", content: JSON.stringify(payload) }] })), {}, async (_, init) => {
    assert.deepEqual(JSON.parse(init?.body as string).state, payload.state);
    assert.deepEqual(JSON.parse(init?.body as string).questions, payload.questions);
    return Response.json(result);
  });
  assert.equal(response.status, 200);
});

for (const extra of [
  { temperature: 0 }, { tools: [] }, { response_format: {} }, { model: "" }, { store: true }, { stream: "true" },
  { messages: [{ role: "user", content: "not JSON" }] },
  { messages: [{ role: "system", content: "hello" }, { role: "user", content: "hi" }] },
  { messages: [{ role: "user", content: [{ type: "image_url", image_url: "https://example.com/image" }] }] },
  { stream_options: { include_usage: true } },
]) {
  test(`reject unsupported input ${JSON.stringify(extra).slice(0, 80)}`, async () => {
    await errorCode(request(body(extra)), "invalid_request", 400);
  });
}
test("invalid question types, criteria, nesting, counts and options never reach upstream", async () => {
  const bad = [
    { state: "x", questions: {} }, { state: 123, questions: decision.questions },
    { state: "x", questions: { x: { type: "text", instructions: "hi" } } },
    { state: "x", questions: { x: { type: "noul", instructions: "hi", criteria: { true: "yes" } } } },
    { state: "x", questions: { x: { type: "score", instructions: "hi", criteria: ["only"] } } },
    { state: "x", questions: { x: { type: "choice", instructions: "hi", criteria: { only: null } } } },
    { ...decision, model: "hidden-model" },
    { state: "x", questions: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [i, decision.questions.refund])) },
  ];
  let deep: any = "x"; for (let i = 0; i < 40; i++) deep = { next: deep };
  bad.push({ ...decision, state: deep });
  for (const value of bad) await errorCode(request(body({ messages: [{ role: "user", content: JSON.stringify(value) }] })), "invalid_request", 400);
});
test("request byte limit and malformed body", async () => {
  await errorCode(request(body({ messages: [{ role: "user", content: "中".repeat(100000) }] })), "payload_too_large", 413);
  const req = new Request("https://bridge.example.com/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  await errorCode(req, "invalid_request", 400);
});
test("header configuration validation", async () => {
  const cases: Record<string, string>[] = [{ "x-jev-timeout-ms": "0" }, { "x-jev-timeout-ms": "60001" }, { "x-jev-timeout-ms": "NaN" }, { "x-jev-result": "weights" }, { "x-jev-provider": "unknown" }, { "x-jev-preset": "toString" }];
  for (const headers of cases) {
    await errorCode(request(body(), headers), "invalid_request", 400);
  }
});
test("upstream errors are sanitized; 429 Retry-After is retained; no retry", async () => {
  let calls = 0;
  const response = await handleRequest(request(), {}, async () => {
    calls++; return Response.json({ error: "leaked-key" }, { status: 429, headers: { "retry-after": "3" } });
  });
  assert.equal(calls, 1); assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "3");
  assert.ok(!(await response.text()).includes("leaked-key"));
});
test("redirects never forward credentials to another destination", async () => {
  const response = await handleRequest(request(), {}, async (_, init) => {
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 307, headers: { location: "https://elsewhere.example.com" } });
  });
  assert.equal(response.status, 502);
});
test("missing answers, bad weights, missing usage, non-JSON and oversized results fail", async () => {
  const variants: unknown[] = [
    { ...result, answers: {} }, { ...result, usage: undefined },
    { ...result, answers: { ...result.answers, refund: { type: "noul", noul: 1.1 } } },
    { ...result, answers: { ...result.answers, team: { type: "choice", choice: "unknown" } } },
    { ...result, answers: { ...result.answers, urgency: { type: "score", score: 3 } } },
    { ...result, answers: { ...result.answers, team: { ...result.answers.team, probabilities: { billing: 0.9 } } } },
  ];
  for (const value of variants) {
    const response = await handleRequest(request(), {}, async () => Response.json(value));
    assert.equal(response.status, 502);
  }
  for (const text of ["<html>unavailable</html>", "x".repeat(1048577)]) {
    const response = await handleRequest(request(), {}, async () => new Response(text));
    assert.equal(response.status, 502);
  }
});
test("deadline aborts fetch and maps to 504", async () => {
  let aborted = false;
  const response = await handleRequest(request(body(), { "x-jev-timeout-ms": "100" }), {}, async (_, init) => new Promise((_, reject) => {
    init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
  }));
  assert.equal(aborted, true); assert.equal(response.status, 504);
});
test("client cancellation is propagated", async () => {
  const controller = new AbortController();
  let aborted = false;
  const pending = handleRequest(request(body(), {}, "/v1/chat/completions", controller.signal), {}, async (_, init) => new Promise((_, reject) => {
    init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
    controller.abort();
  }));
  assert.equal((await pending).status, 499); assert.equal(aborted, true);
});
test("CORS preflight supports custom headers only for configured browser origins", async () => {
  const preflight = () => new Request("https://bridge.example.com/v1/responses", { method: "OPTIONS", headers: { origin: "https://app.example.com" } });
  assert.equal((await handleRequest(preflight(), {}, forbidden)).status, 403);
  const response = await handleRequest(preflight(), { CORS_ORIGINS: "https://app.example.com", BRIDGE_API_KEY: "secret" }, forbidden);
  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-headers")!, /X-Jev-Endpoint/);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example.com");
});
test("health/models/method/unknown routes", async () => {
  for (const path of ["/health", "/v1/models"]) assert.equal((await handleRequest(new Request(`https://bridge.example.com${path}`), {}, forbidden)).status, 200);
  assert.equal((await handleRequest(new Request("https://bridge.example.com/v1/responses"), {}, forbidden)).status, 405);
  assert.equal((await handleRequest(new Request("https://bridge.example.com/nope"), {}, forbidden)).status, 404);
});

function sdk(): OpenAI {
  return new OpenAI({ apiKey: "sdk-test-key", baseURL: "https://bridge.example.com/v1", maxRetries: 0,
    defaultHeaders: { "X-Jev-Provider": "typesafe" },
    fetch: async (input, init) => handleRequest(new Request(input, init), {}, good),
  });
}
test("OpenAI SDK chat non-stream and streaming usage work without extra_body", async () => {
  const client = sdk();
  const args = { model: "jev-1.13.0", messages: [{ role: "user" as const, content: JSON.stringify(decision) }] };
  const completion = await client.chat.completions.create(args);
  assert.deepEqual(JSON.parse(completion.choices[0].message.content!), result.answers);
  const stream = await client.chat.completions.create({ ...args, stream: true, stream_options: { include_usage: true } });
  let text = "", usage, stopped = false;
  for await (const event of stream) {
    text += event.choices[0]?.delta.content ?? "";
    if (event.choices[0]?.finish_reason === "stop") stopped = true;
    if (event.usage) usage = event.usage;
  }
  assert.equal(stopped, true); assert.equal(usage?.total_tokens, 546);
  assert.deepEqual(JSON.parse(text), result.answers);
});
test("OpenAI SDK Responses non-stream output_text and event stream work", async () => {
  const client = sdk();
  const args = { model: "jev-1.13.0", input: JSON.stringify(decision), store: false };
  const response = await client.responses.create(args);
  assert.deepEqual(JSON.parse(response.output_text), result.answers);
  const events = await client.responses.create({ ...args, stream: true });
  const types: string[] = [];
  let text = "", sequence = -1;
  for await (const event of events) {
    types.push(event.type);
    assert.equal(event.sequence_number, ++sequence);
    if (event.type === "response.output_text.delta") text += event.delta;
    if (event.type === "response.completed") assert.equal(event.response.usage?.total_tokens, 546);
  }
  assert.deepEqual(JSON.parse(text), result.answers);
  assert.equal(types[0], "response.created"); assert.equal(types.at(-1), "response.completed");
  const runner = client.responses.stream(args);
  const final = await runner.finalResponse();
  assert.deepEqual(JSON.parse(final.output_text), result.answers);
});
test("Responses accepts one user text message but rejects stateful options", async () => {
  const response = await handleRequest(request({ model: "jev-latest", api_key: "key", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: JSON.stringify(decision) }] }] }, {}, "/v1/responses"), {}, good);
  assert.equal(response.status, 200);
  for (const extra of [{ previous_response_id: "resp_old" }, { background: true }, { store: true }]) {
    await errorCode(request({ model: "jev-latest", api_key: "key", input: JSON.stringify(decision), ...extra }, {}, "/v1/responses"), "invalid_request", 400);
  }
});
