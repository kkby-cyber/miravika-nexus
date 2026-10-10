import { createStart, createCsrfMiddleware, createMiddleware } from "@tanstack/react-start";

import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";
import { validateServerEnv } from "@/lib/env.server";
import { renderErrorPage } from "./lib/error-page";

const securityHeaders = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(self)",
};

// Only the Lovable editor may frame the admin (for its live preview). Browsers that support
// CSP frame-ancestors use it in place of X-Frame-Options; older ones still get DENY.
const FRAME_ANCESTORS = "'self' https://lovable.dev https://*.lovable.dev";

function applySecurityHeaders(response: Response): Response {
  // Protocol upgrades must pass through untouched.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(securityHeaders)) {
    headers.set(key, value);
  }

  if (process.env["NODE_ENV"] === "production") {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");

    headers.set(
      "content-security-policy",
      "default-src 'self'; " +
        "base-uri 'self'; " +
        "object-src 'none'; " +
        `frame-ancestors ${FRAME_ANCESTORS}; ` +
        "form-action 'self'; " +
        "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "img-src 'self' data: blob: https://*.supabase.co; " +
        "font-src 'self' data: https://fonts.gstatic.com; " +
        "connect-src 'self' https://*.supabase.co https://api.razorpay.com; " +
        "frame-src https://checkout.razorpay.com https://api.razorpay.com",
    );
  }

  // Re-wrap the body stream instead of buffering it, so SSR streaming is preserved.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    validateServerEnv();
    const result = await next();
    return applySecurityHeaders(result.response);
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }

    console.error(error);

    return applySecurityHeaders(
      new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
  }
});

// Keep CSRF protection for server functions.
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
  failureResponse: (ctx) => {
    // Diagnostics go to the server log only; the client gets a generic rejection.
    console.error(
      JSON.stringify({
        level: "error",
        event: "csrf_rejected",
        method: ctx.request.method,
        path: new URL(ctx.request.url).pathname,
        origin: ctx.request.headers.get("Origin"),
        sec_fetch_site: ctx.request.headers.get("Sec-Fetch-Site"),
      }),
    );

    return Response.json(
      { success: false, error: { code: "CSRF_REJECTED", message: "Request rejected." } },
      { status: 403 },
    );
  },
});

export const startInstance = createStart(() => ({
  functionMiddleware: [attachSupabaseAuth],
  requestMiddleware: [errorMiddleware, csrfMiddleware],
}));
