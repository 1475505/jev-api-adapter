// Body api_key variant; no OpenAI SDK or extra_body needed.
const apiKey = process.env.JEV_API_KEY;
if (!apiKey) throw new Error("Set JEV_API_KEY to your upstream API key.");
const headers: Record<string, string> = {
  "Content-Type": "application/json",
  "X-Jev-Preset": "sentiment-v1",
};
if (process.env.JEV_PROVIDER) headers["X-Jev-Provider"] = process.env.JEV_PROVIDER;
if (process.env.JEV_ENDPOINT) headers["X-Jev-Endpoint"] = process.env.JEV_ENDPOINT;
if (process.env.BRIDGE_API_KEY) headers["X-Bridge-Key"] = process.env.BRIDGE_API_KEY;
const response = await fetch(`${process.env.BRIDGE_BASE_URL ?? "http://localhost:8787/v1"}/chat/completions`, {
  method: "POST", headers,
  body: JSON.stringify({ model: process.env.JEV_MODEL ?? "typesafe/jev-1.13", api_key: apiKey, messages: [{ role: "user", content: "体验很好，下次还会来！" }] }),
});
if (!response.ok) throw new Error(`Bridge returned ${response.status}: ${await response.text()}`);
const result = await response.json() as { choices: { message: { content: string } }[] };
console.log(JSON.parse(result.choices[0].message.content));
export {};
