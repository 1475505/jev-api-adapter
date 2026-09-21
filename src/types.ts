export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Guidance = string | Json[] | { [key: string]: Json };
export type Question =
  | { type: "noul"; instructions: Guidance; criteria?: { true: Guidance; false: Guidance } }
  | { type: "choice"; instructions: Guidance; criteria: Record<string, Guidance | null> }
  | { type: "score"; instructions: Guidance; criteria: Guidance[] };
export interface Decision { state: Guidance; questions: Record<string, Question> }
export type Provider = "typesafe" | "vercel" | "openrouter";
export type Format = "chat" | "responses";
export interface Env {
  BRIDGE_API_KEY?: string;
  ALLOWED_UPSTREAM_ORIGINS?: string;
  CORS_ORIGINS?: string;
}
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface Call {
  format: Format;
  model: string;
  apiKey: string;
  stream: boolean;
  includeUsage: boolean;
  decision: Decision;
}
export interface Route {
  provider: Provider;
  endpoint: string;
  timeoutMs: number;
  result: "answers" | "full";
}
export interface DecisionResult {
  model: string;
  answers: Record<string, Json>;
  usage: { input_tokens: number; output_tokens: number; [key: string]: Json };
  [key: string]: Json;
}
