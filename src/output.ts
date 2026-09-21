import type { Call, DecisionResult, Route } from "./types.ts";

export function encodeResult(call: Call, route: Route, result: DecisionResult, requestId: string): Response {
  const text = JSON.stringify(route.result === "full" ? result : result.answers);
  const created = Math.floor(Date.now() / 1000);
  const id = `${call.format === "chat" ? "chatcmpl" : "resp"}_${crypto.randomUUID().replaceAll("-", "")}`;
  const headers = new Headers({ "cache-control": "no-store", "x-request-id": requestId, "x-jev-provider": route.provider });
  const input = result.usage.input_tokens;
  const output = result.usage.output_tokens;
  const chatUsage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
  if (call.format === "chat") {
    const base = { id, created, model: result.model };
    if (!call.stream) return Response.json({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text, refusal: null }, finish_reason: "stop", logprobs: null }], usage: chatUsage }, { headers });
    const chunk = (delta: object, finish: string | null = null) => ({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }], ...(call.includeUsage ? { usage: null } : {}) });
    const events: object[] = [chunk({ role: "assistant", content: "" }), chunk({ content: text }), chunk({}, "stop")];
    if (call.includeUsage) events.push({ ...base, object: "chat.completion.chunk", choices: [], usage: chatUsage });
    headers.set("content-type", "text/event-stream; charset=utf-8");
    return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", { headers });
  }
  const part = { type: "output_text", text, annotations: [], logprobs: [] };
  const message = { id: `msg_${crypto.randomUUID().replaceAll("-", "")}`, type: "message", role: "assistant", status: "completed", content: [part] };
  const response = {
    id, object: "response", created_at: created, completed_at: created, status: "completed", model: result.model,
    output: [message], error: null, incomplete_details: null, instructions: null, max_output_tokens: null,
    parallel_tool_calls: false, previous_response_id: null, reasoning: { effort: null, summary: null },
    store: false, background: false, temperature: null, text: { format: { type: "text" } },
    tool_choice: "none", tools: [], top_p: null, truncation: "disabled", metadata: {},
    usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
  };
  if (!call.stream) return Response.json(response, { headers });
  const pending = { ...response, status: "in_progress", completed_at: null, output: [], usage: null };
  const pendingMessage = { ...message, status: "in_progress", content: [] };
  const pendingPart = { ...part, text: "" };
  const position = { item_id: message.id, output_index: 0, content_index: 0 };
  const events = [
    { type: "response.created", response: pending },
    { type: "response.in_progress", response: pending },
    { type: "response.output_item.added", output_index: 0, item: pendingMessage },
    { type: "response.content_part.added", ...position, part: pendingPart },
    { type: "response.output_text.delta", ...position, delta: text, logprobs: [] },
    { type: "response.output_text.done", ...position, text, logprobs: [] },
    { type: "response.content_part.done", ...position, part },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response },
  ];
  headers.set("content-type", "text/event-stream; charset=utf-8");
  return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""), { headers });
}
