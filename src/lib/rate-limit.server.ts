import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logEvent } from "@/lib/api-response";

type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
  error?: boolean;
};

type RateLimitDatabase = {
  rpc: (
    functionName: string,
    args: Record<string, string | number>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

type RateLimitPayload = {
  allowed?: boolean;
  remaining?: number;
  retry_after?: number;
};

async function requestKey(request: Request, scope: string) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || request.headers.get("cf-connecting-ip") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
  const hash = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${scope}:${hash}`;
}

export async function enforceRateLimit(
  request: Request,
  scope: string,
  limit: number,
  windowSeconds = 60,
): Promise<RateLimitResult> {
  try {
    const key = await requestKey(request, scope);
    const { data, error } = await (supabaseAdmin as unknown as RateLimitDatabase).rpc(
      "consume_rate_limit",
      {
        _key: key,
        _limit: limit,
        _window_seconds: windowSeconds,
      },
    );
    if (error || !data) {
      logEvent("error", "rate_limit_unavailable", { scope });
      return { allowed: false, remaining: 0, retryAfter: windowSeconds, error: true };
    }
    const payload = data as RateLimitPayload;
    return {
      allowed: Boolean(payload.allowed),
      remaining: Number(payload.remaining ?? 0),
      retryAfter: Number(payload.retry_after ?? windowSeconds),
    };
  } catch {
    logEvent("error", "rate_limit_unavailable", { scope });
    return { allowed: false, remaining: 0, retryAfter: windowSeconds, error: true };
  }
}
