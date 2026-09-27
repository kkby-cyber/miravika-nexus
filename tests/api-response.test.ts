import { afterEach, describe, expect, it, vi } from "vitest";

const getRequestMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: (...args: unknown[]) => getRequestMock(...args),
}));

import { ok, preflight } from "../src/lib/api-response";

function preflightRequest(origin: string) {
  return new Request("https://api.miravika.com/api/public/cart", {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-cart-token",
    },
  });
}

function allowedHeaders(response: Response) {
  return (response.headers.get("access-control-allow-headers") ?? "")
    .split(",")
    .map((header) => header.trim())
    .filter(Boolean);
}

describe("Nexus CORS contract", () => {
  afterEach(() => {
    getRequestMock.mockReset();
    vi.unstubAllEnvs();
  });

  it("allows the production storefront origins used by the API", () => {
    for (const origin of [
      "https://miravika.com",
      "https://www.miravika.com",
      "https://admin.miravika.com",
    ]) {
      getRequestMock.mockReturnValue(preflightRequest(origin));
      const response = preflight();

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("vary")).toBe("Origin");
      expect(response.headers.get("access-control-allow-methods")).toContain("OPTIONS");
      expect(allowedHeaders(response)).toEqual(
        expect.arrayContaining([
          "content-type",
          "authorization",
          "apikey",
          "x-request-id",
          "x-cart-token",
          "x-idempotency-key",
        ]),
      );
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      expect(response.headers.get("x-request-id")).toBeTruthy();
    }
  });

  it("does not reflect untrusted origins or use a wildcard", () => {
    getRequestMock.mockReturnValue(preflightRequest("https://untrusted.example"));
    const response = preflight();

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(allowedHeaders(response)).toContain("x-cart-token");
  });

  it("allows localhost only outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    getRequestMock.mockReturnValue(preflightRequest("http://localhost:5173"));
    expect(preflight().headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

    vi.stubEnv("NODE_ENV", "production");
    getRequestMock.mockReturnValue(preflightRequest("http://localhost:5173"));
    expect(preflight().headers.get("access-control-allow-origin")).toBeNull();
  });

  it("applies the same guest-cart CORS contract to normal API responses", () => {
    getRequestMock.mockReturnValue(
      new Request("https://api.miravika.com/api/public/cart", {
        headers: { origin: "https://miravika.com" },
      }),
    );

    const response = ok({ cart_token: "server-issued-token" });
    expect(response.headers.get("access-control-allow-origin")).toBe("https://miravika.com");
    expect(allowedHeaders(response)).toContain("x-cart-token");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });
});
