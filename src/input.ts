import { ApiError, invalid } from "./errors.ts";
import { PRESETS } from "./presets.ts";
import type { Call, Decision, Format } from "./types.ts";

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function guidance(value: unknown): boolean {
  return typeof value === "string" || Array.isArray(value) || record(value);
}
export function onlyKeys(value: Record<string, unknown>, keys: string[], param: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(`Unsupported field: ${param ? param + "." : ""}${key}.`, param ? `${param}.${key}` : key);
}

// Bounds actual bytes, including bodies without Content-Length.
export async function readBounded(body: ReadableStream<Uint8Array> | null, max: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new ApiError(413, "payload_too_large", `JSON body exceeds ${max} bytes.`);
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

function validateDepth(root: unknown): void {
  const pending: [unknown, number][] = [[root, 0]];
  while (pending.length) {
    const [value, depth] = pending.pop()!;
    if (depth > 32) invalid("JSON nesting exceeds 32 levels.", "input");
    if (Array.isArray(value) || record(value)) for (const child of Object.values(value)) pending.push([child, depth + 1]);
  }
}

export function validateDecision(value: unknown): Decision {
  if (!record(value)) invalid("Input must encode a JSON object with state and questions.", "input");
  onlyKeys(value, ["state", "questions"], "input");
  validateDepth(value);
  if (!guidance(value.state)) invalid("state must be text, an object, or an array.", "input.state");
  if (!record(value.questions)) invalid("questions must be an object.", "input.questions");
  const entries = Object.entries(value.questions);
  if (!entries.length || entries.length > 64) invalid("Provide between 1 and 64 questions.", "input.questions");
  for (const [id, question] of entries) {
    const p = `input.questions.${id}`;
    if (!id || id.length > 128) invalid("Question IDs must contain 1–128 characters.", "input.questions");
    if (!record(question)) invalid("Question must be an object.", p);
    onlyKeys(question, ["type", "instructions", "criteria"], p);
    if (!guidance(question.instructions)) invalid("instructions must be text, an object, or an array.", `${p}.instructions`);
    const criteria = question.criteria;
    if (question.type === "noul") {
      if (criteria !== undefined) {
        if (!record(criteria) || !guidance(criteria.true) || !guidance(criteria.false)) invalid("Noul criteria require true and false guidance.", `${p}.criteria`);
        onlyKeys(criteria, ["true", "false"], `${p}.criteria`);
      }
    } else if (question.type === "choice") {
      if (!record(criteria) || Object.keys(criteria).length < 2 || Object.keys(criteria).length > 255) invalid("Choice requires 2–255 criteria.", `${p}.criteria`);
      if (Object.entries(criteria).some(([k, v]) => !k || (v !== null && !guidance(v)))) invalid("Each choice must have a nonempty key and guidance or null.", `${p}.criteria`);
    } else if (question.type === "score") {
      if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10 || !criteria.every(guidance)) invalid("Score requires 2–10 ordered guidance levels.", `${p}.criteria`);
    } else invalid("Question type must be noul, choice, or score.", `${p}.type`);
  }
  return value as unknown as Decision;
}

function textContent(value: unknown, kind: "text" | "input_text", param: string): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || !value.length) invalid("Expected text or text content parts.", param);
  return value.map((part) => {
    if (!record(part) || part.type !== kind || typeof part.text !== "string") invalid("Only text content parts are supported.", param);
    onlyKeys(part, ["type", "text"], param);
    return part.text;
  }).join("");
}
function messageText(value: unknown, format: Format): string {
  const param = format === "chat" ? "messages" : "input";
  if (format === "responses" && typeof value === "string") return value;
  if (!Array.isArray(value) || value.length !== 1 || !record(value[0])) invalid("Supply exactly one user message; conversation history is not supported.", param);
  const message = value[0];
  onlyKeys(message, ["role", "content", ...(format === "responses" ? ["type"] : [])], param);
  if (message.role !== "user" || (message.type !== undefined && message.type !== "message")) invalid("Expected a user message.", param);
  return textContent(message.content, format === "chat" ? "text" : "input_text", `${param}.content`);
}

export function credentials(bodyKey: unknown, headers: Headers): string {
  const auth = headers.get("authorization");
  const match = auth?.match(/^Bearer ([^\s]+)$/i);
  if (auth !== null && !match) invalid("Authorization must contain a Bearer API key.", "Authorization");
  if (bodyKey !== undefined && (typeof bodyKey !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(bodyKey))) invalid("api_key must be a nonempty ASCII token without whitespace.", "api_key");
  if (bodyKey !== undefined && match && bodyKey !== match[1]) invalid("api_key and Authorization disagree.", "api_key");
  const key = (bodyKey as string | undefined) ?? match?.[1];
  if (!key) throw new ApiError(401, "missing_api_key", "Provide api_key in the body or Authorization: Bearer <upstream key>.");
  if (!/^[\x21-\x7e]{1,4096}$/.test(key)) invalid("Invalid API key format.", "Authorization");
  return key;
}

export async function parseCall(request: Request, format: Format): Promise<Call> {
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new ApiError(415, "unsupported_media_type", "Use Content-Type: application/json.");
  let body: unknown;
  try { body = JSON.parse(await readBounded(request.body, 262144)); }
  catch (e) { if (e instanceof ApiError) throw e; invalid("Body must be valid UTF-8 JSON.", "body"); }
  if (!record(body)) invalid("Body must be a JSON object.", "body");
  onlyKeys(body, ["model", "api_key", "stream", "store", ...(format === "chat" ? ["messages", "stream_options"] : ["input", "background"])], "");
  if (typeof body.model !== "string" || !body.model.trim() || body.model.length > 256) invalid("model must contain 1–256 characters.", "model");
  if (body.stream !== undefined && typeof body.stream !== "boolean") invalid("stream must be boolean.", "stream");
  if (body.store !== undefined && body.store !== false) invalid("Only store:false is supported; the bridge is stateless.", "store");
  if (body.background !== undefined && body.background !== false) invalid("Background requests are not supported.", "background");
  let includeUsage = false;
  if (body.stream_options !== undefined) {
    if (body.stream !== true || !record(body.stream_options)) invalid("stream_options requires stream:true.", "stream_options");
    onlyKeys(body.stream_options, ["include_usage"], "stream_options");
    if (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== "boolean") invalid("include_usage must be boolean.", "stream_options.include_usage");
    includeUsage = body.stream_options.include_usage === true;
  }
  const apiKey = credentials(body.api_key, request.headers);
  const text = messageText(format === "chat" ? body.messages : body.input, format);
  const preset = request.headers.get("x-jev-preset");
  let decision: Decision;
  if (preset !== null) {
    if (!Object.hasOwn(PRESETS, preset)) invalid("Unknown preset. Available: " + Object.keys(PRESETS).join(", "), "X-Jev-Preset");
    decision = { state: text, questions: PRESETS[preset] };
  } else {
    let payload: unknown;
    try { payload = JSON.parse(text); }
    catch { invalid("Input must be a JSON string containing state and questions, or select X-Jev-Preset for plain text.", "input"); }
    decision = validateDecision(payload);
  }
  return { format, model: body.model, apiKey, stream: body.stream === true, includeUsage, decision };
}
