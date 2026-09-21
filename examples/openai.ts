import OpenAI from "openai";

const apiKey = process.env.JEV_API_KEY;
if (!apiKey) throw new Error("Set JEV_API_KEY to your upstream API key.");
const headers: Record<string, string> = {};
if (process.env.JEV_PROVIDER) headers["X-Jev-Provider"] = process.env.JEV_PROVIDER;
if (process.env.JEV_ENDPOINT) headers["X-Jev-Endpoint"] = process.env.JEV_ENDPOINT;
if (process.env.BRIDGE_API_KEY) headers["X-Bridge-Key"] = process.env.BRIDGE_API_KEY;
const client = new OpenAI({
  baseURL: process.env.BRIDGE_BASE_URL ?? "http://localhost:8787/v1",
  apiKey,
  defaultHeaders: headers,
  maxRetries: 0,
});
const input = JSON.stringify({
  state: "订单重复扣款，请尽快退款。",
  questions: {
    refund: { type: "noul", instructions: "Is the customer requesting a refund?" },
    department: {
      type: "choice", instructions: "Which department should handle this request?",
      criteria: { billing: "Payments, refunds and invoices", technical: "Technical failures", other: "Other requests" },
    },
  },
});
const model = process.env.JEV_MODEL ?? "typesafe/jev-1.13";

// Change EXAMPLE_API to chat or stream to exercise another route. Only one
// upstream decision is made per example execution.
if (process.env.EXAMPLE_API === "chat") {
  const result = await client.chat.completions.create({ model, messages: [{ role: "user", content: input }] });
  console.log(JSON.parse(result.choices[0].message.content!));
} else if (process.env.EXAMPLE_API === "stream") {
  const stream = await client.responses.create({ model, input, store: false, stream: true });
  for await (const event of stream) if (event.type === "response.output_text.delta") process.stdout.write(event.delta);
  process.stdout.write("\n");
} else {
  const result = await client.responses.create({ model, input, store: false });
  console.log(JSON.parse(result.output_text));
}
