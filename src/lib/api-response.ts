import { getRequest } from "@tanstack/react-start/server";

const PRODUCTION_ORIGINS = new Set([
  "https://miravika.com",
  "https://www.miravika.com",
  "https://admin.miravika.com",
]);

function corsHeaders(origin: string | null) {
  const developmentOrigin =
    process.env["NODE_ENV"] !== "production" && origin?.startsWith("http://localhost:")
      ? origin
      : null;
  const allowedOrigin =
    origin && (PRODUCTION_ORIGINS.has(origin) || developmentOrigin) ? origin : null;
  return {
    ...(allowedOrigin ? { "access-control-allow-origin": allowedOrigin } : {}),
    vary: "Origin",
    "access-control-expose-headers": "x-request-id",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers":
      "content-type,authorization,apikey,x-request-id,x-cart-token,x-idempotency-key",
  };
}

function currentRequest() {
  try {
    return getRequest();
  } catch {
    return undefined;
  }
}

const requestIds = new WeakMap<Request, string>();

export function requestId(request?: Request) {
  const activeRequest = request ?? currentRequest();
  if (activeRequest) {
    const existing = requestIds.get(activeRequest);
    if (existing) return existing;
  }
  const candidate = activeRequest?.headers.get("x-request-id");
  const id =
    candidate && /^[a-zA-Z0-9._:-]{1,100}$/.test(candidate) ? candidate : crypto.randomUUID();
  if (activeRequest) requestIds.set(activeRequest, id);
  return id;
}

function responseHeaders(id: string) {
  const request = currentRequest();
  return {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-request-id": id,
    ...corsHeaders(request?.headers.get("origin") ?? null),
  };
}

export function ok(data: unknown, status = 200) {
  const id = requestId();
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: responseHeaders(id),
  });
}

export function fail(code: string, message: string, status = 400) {
  const id = requestId();
  return new Response(
    JSON.stringify({ success: false, error: { code, message, request_id: id } }),
    {
      status,
      headers: responseHeaders(id),
    },
  );
}

export function preflight() {
  const id = requestId();
  const request = currentRequest();
  return new Response(null, {
    status: 204,
    headers: { ...corsHeaders(request?.headers.get("origin") ?? null), "x-request-id": id },
  });
}

/** Structured log line. Never pass secrets or payment credentials in `extra`. */
export function logEvent(
  level: "info" | "error",
  event: string,
  extra: Record<string, unknown> = {},
) {
  const line = JSON.stringify({
    level,
    event,
    request_id: requestId(),
    ts: new Date().toISOString(),
    ...extra,
  });
  if (level === "error") console.error(line);
  else console.log(line);
}
