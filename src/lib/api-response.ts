const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,apikey",
};

export function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
  });
}

export function fail(code: string, message: string, status = 400) {
  return new Response(JSON.stringify({ success: false, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
  });
}

export function preflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function requestId() {
  return crypto.randomUUID();
}

/** Structured log line. Never pass secrets or payment credentials in `extra`. */
export function logEvent(
  level: "info" | "error",
  event: string,
  extra: Record<string, unknown> = {},
) {
  const line = JSON.stringify({ level, event, ts: new Date().toISOString(), ...extra });
  if (level === "error") console.error(line);
  else console.log(line);
}
