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

async function applySecurityHeaders(response: Response): Promise<Response> {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(securityHeaders)) {
    headers.set(key, value);
  }

  if (process.env["NODE_ENV"] === "production") {
    headers.set(
      "strict-transport-security",
      "max-age=31536000; includeSubDomains",
    );

    headers.set(
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

  const body = await response.arrayBuffer();

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const errorMiddleware = createMiddleware().server(
  async ({ next }) => {
    try {
      validateServerEnv();
      return await next();
    } catch (error) {
      if (
        error != null &&
        typeof error === "object" &&
        "statusCode" in error
      ) {
        throw error;
      }

      console.error(error);

      return new Response(renderErrorPage(), {
        status: 500,
        headers: {
          "content-type": "text/html; charset=utf-8",
          ...securityHeaders,
        },
      });
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
