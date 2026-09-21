import assert from "node:assert/strict";
import { test } from "node:test";
import health from "../api/health.ts";
import models from "../api/v1/models.ts";
import responses from "../api/v1/responses.ts";
import chat from "../api/v1/chat/completions.ts";

test("Vercel entrypoints preserve request body and use deployment secrets", async () => {
  const originalFetch = globalThis.fetch;
  const oldSecret = process.env.BRIDGE_API_KEY;
  process.env.BRIDGE_API_KEY = "bridge-test-secret";
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), "https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer example-upstream-key");
    const sent = JSON.parse(init?.body as string);
    assert.equal(sent.state, "退款");
    return Response.json({ model: sent.model, answers: { refund: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 2 } });
  };
  try {
    assert.equal((await health.fetch(new Request("https://app.example.com/api/health"))).status, 200);
    assert.equal((await models.fetch(new Request("https://app.example.com/api/v1/models"))).status, 401);
    const headers = { "content-type": "application/json", "x-bridge-key": "bridge-test-secret", "x-jev-provider": "vercel" };
    const input = JSON.stringify({ state: "退款", questions: { refund: { type: "noul", instructions: "Refund?" } } });
    for (const [handler, path, content] of [
      [responses, "/api/v1/responses", { input }],
      [chat, "/api/v1/chat/completions", { messages: [{ role: "user", content: input }] }],
    ] as const) {
      const result = await handler.fetch(new Request(`https://app.example.com${path}`, { method: "POST", headers, body: JSON.stringify({ model: "typesafe-ai/jev", api_key: "example-upstream-key", ...content }) }));
      assert.equal(result.status, 200);
      const data = await result.json() as any;
      const text = data.object === "response" ? data.output[0].content[0].text : data.choices[0].message.content;
      assert.deepEqual(JSON.parse(text), { refund: { type: "noul", noul: 0.9 } });
    }
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldSecret === undefined) delete process.env.BRIDGE_API_KEY;
    else process.env.BRIDGE_API_KEY = oldSecret;
  }
});
