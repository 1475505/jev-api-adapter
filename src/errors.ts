export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public param: string | null = null,
    public retryAfter?: string,
  ) { super(message); }
}

export function invalid(message: string, param: string): never {
  throw new ApiError(400, "invalid_request", message, param);
}

export function errorResponse(error: unknown, requestId: string): Response {
  const e = error instanceof ApiError ? error : new ApiError(500, "internal_error", "Internal bridge error.");
  const type = e.status === 401 ? "authentication_error" : e.status === 429 ? "rate_limit_error"
    : e.status < 500 ? "invalid_request_error" : "api_error";
  const headers = new Headers({ "x-request-id": requestId, "cache-control": "no-store" });
  if (e.retryAfter) headers.set("retry-after", e.retryAfter);
  return Response.json({ error: { message: e.message, type, param: e.param, code: e.code } }, { status: e.status, headers });
}
