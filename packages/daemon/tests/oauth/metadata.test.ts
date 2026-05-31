// T-P3-001: unit tests for the OAuth Authorization Server Metadata
// endpoint. Covers Decision d (advertise only what we ship; S256-only,
// client_secret_post-only, no revocation/introspection endpoints) and
// the Host-derived URL invariant (design §5: tunnel URL rotates; never
// hardcode).

import { describe, it, expect } from "vitest";
import { buildMetadata, deriveBaseUrl } from "../../src/oauth/metadata.js";
import type { IncomingMessage } from "node:http";

function mockReq(host: string | undefined): IncomingMessage {
  return {
    headers: host === undefined ? {} : { host },
  } as unknown as IncomingMessage;
}

describe("deriveBaseUrl (T-P3-001 Host-derived URLs)", () => {
  it("returns https://<host> for a tunnel-shaped host", () => {
    expect(deriveBaseUrl(mockReq("plum-otter-7821.trycloudflare.com"))).toBe(
      "https://plum-otter-7821.trycloudflare.com",
    );
  });

  it("returns http://localhost for local development", () => {
    expect(deriveBaseUrl(mockReq("localhost:7423"))).toBe(
      "http://localhost:7423",
    );
  });

  it("returns http://127.0.0.1 for loopback IP", () => {
    expect(deriveBaseUrl(mockReq("127.0.0.1:7423"))).toBe(
      "http://127.0.0.1:7423",
    );
  });

  it("falls back to http://localhost when Host header is absent", () => {
    expect(deriveBaseUrl(mockReq(undefined))).toBe("http://localhost");
  });
});

describe("buildMetadata (T-P3-001 Decision d: ship-only-what-we-ship)", () => {
  it("constructs all four URLs from inbound Host", () => {
    const m = buildMetadata(mockReq("example.trycloudflare.com"));
    expect(m.issuer).toBe("https://example.trycloudflare.com");
    expect(m.authorization_endpoint).toBe(
      "https://example.trycloudflare.com/authorize",
    );
    expect(m.token_endpoint).toBe("https://example.trycloudflare.com/token");
    expect(m.registration_endpoint).toBe(
      "https://example.trycloudflare.com/register",
    );
  });

  it("URLs change accordingly when Host changes (tunnel-rotation safe)", () => {
    const a = buildMetadata(mockReq("a.trycloudflare.com"));
    const b = buildMetadata(mockReq("b.trycloudflare.com"));
    expect(a.issuer).not.toBe(b.issuer);
    expect(a.authorization_endpoint).not.toBe(b.authorization_endpoint);
    expect(a.token_endpoint).not.toBe(b.token_endpoint);
    expect(a.registration_endpoint).not.toBe(b.registration_endpoint);
  });

  it("advertises S256-only PKCE (no `plain`)", () => {
    const m = buildMetadata(mockReq("x.trycloudflare.com"));
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("advertises authorization_code only (no other grants)", () => {
    const m = buildMetadata(mockReq("x.trycloudflare.com"));
    expect(m.grant_types_supported).toEqual(["authorization_code"]);
  });

  it("advertises response_type=code only", () => {
    const m = buildMetadata(mockReq("x.trycloudflare.com"));
    expect(m.response_types_supported).toEqual(["code"]);
  });

  it("advertises client_secret_post only as token endpoint auth method", () => {
    const m = buildMetadata(mockReq("x.trycloudflare.com"));
    expect(m.token_endpoint_auth_methods_supported).toEqual([
      "client_secret_post",
    ]);
  });

  it("does NOT advertise revocation or introspection endpoints (we don't ship them)", () => {
    const m = buildMetadata(mockReq("x.trycloudflare.com")) as Record<
      string,
      unknown
    >;
    expect(m.revocation_endpoint).toBeUndefined();
    expect(m.introspection_endpoint).toBeUndefined();
  });
});
