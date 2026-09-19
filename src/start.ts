import {
  createStart,
  createCsrfMiddleware,
  createMiddleware,
} from "@tanstack/react-start";

import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";
import { validateServerEnv } from "@/lib/env.server";
import { renderErrorPage } from "./lib/error-page";

const securityHeaders = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(self)",
};

function applySecurityHeaders(response: Response): Response {
  for (const [key, value] of Object.entries(securityHeaders)) {
    response.headers.set(key, value);
  }

  if (process.env["NODE_ENV"] === "production") {
    response.headers.set(
      "strict-transport-security",
      "max-age=31536000; includeSubDomains",
    );

    response.headers.set(
      "content-security-policy",
      "default-src 'self'; " +
        "base-uri 'self'; " +
        "object-src 'none'; " +
        "frame-ancestors 'none'; " +
        "form-action 'self'; " +
        "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob: https://*.supabase.co; " +
        "font-src 'self' data:; " +
        "connect-src 'self' https://*.supabase.co https://api.razorpay.com; " +
        "frame-src https://checkout.razorpay.com https://api.razorpay.com",
    );
  }

  return response;
}

const errorMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    try {
      validateServerEnv();

      const response = (await next()) as unknown as Response;

      // IMPORTANT:
      // Mutate the existing Response headers instead of constructing
      // a new Response(response.body). Re-wrapping the Response can
      // consume/lose the body under the current TanStack Start runtime.
      return applySecurityHeaders(response);
    } catch (error) {
      if (
        error != null &&
        typeof error === "object" &&
        "statusCode" in error
      ) {
        throw error;
      }

      console.error(error);

      return applySecurityHeaders(
        new Response(renderErrorPage(), {
          status: 500,
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        }),
      );
    }
  },
);

// Keep CSRF protection for server functions.
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  functionMiddleware: [attachSupabaseAuth],
  requestMiddleware: [errorMiddleware, csrfMiddleware],
}));
