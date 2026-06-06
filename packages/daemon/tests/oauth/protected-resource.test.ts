// CB-OAUTH-DISCOVERY-FIX: unit tests for the RFC 9728 Protected Resource
// Metadata endpoint. Covers the Host-derived URL invariant (tunnel rotation)
// and the document shape (resource + authorization_servers point at our own
// issuer; bearer_methods_supported advertises header auth). The routing/
// public-reachability assertions live in router.test.ts (the bug was a
// guarded/unimplemented route, so reachability is tested at the router).

import { describe, it, expect } from "vitest";
import {
  buildProtectedResourceMetadata,
} from "../../src/oauth/protected-resource.js";
import { OAuthProtectedResourceMetadataSchema } from "@claude-bridge/shared";
import type { IncomingMessage } from "node:http";

function mockReq(host: string | undefined): IncomingMessage {
  return {
    headers: host === undefined ? {} : { host },
  } as unknown as IncomingMessage;
}

describe("buildProtectedResourceMetadata (CB-OAUTH-DISCOVERY-FIX, RFC 9728)", () => {
  it("resource + authorization_servers are the Host-derived base (its own issuer)", () => {
    const m = buildProtectedResourceMetadata(mockReq("example.trycloudflare.com"));
    expect(m.resource).toBe("https://example.trycloudflare.com");
    expect(m.authorization_servers).toEqual(["https://example.trycloudflare.com"]);
  });

  it("authorization_servers matches the RFC 8414 issuer (same base) — chain points back to us", () => {
    // The auth-server metadata advertises issuer = base; the protected-resource
    // doc must point its authorization_servers at that same issuer so the
    // client's chain (RFC 9728 -> RFC 8414) resolves to one server.
    const host = "plum-otter-7821.trycloudflare.com";
    const m = buildProtectedResourceMetadata(mockReq(host));
    expect(m.authorization_servers[0]).toBe(`https://${host}`);
  });

  it("advertises bearer header auth (RFC 9728 bearer_methods_supported)", () => {
    const m = buildProtectedResourceMetadata(mockReq("x.trycloudflare.com"));
    expect(m.bearer_methods_supported).toEqual(["header"]);
  });

  it("URLs rotate with Host (tunnel-rotation safe)", () => {
    const a = buildProtectedResourceMetadata(mockReq("a.trycloudflare.com"));
    const b = buildProtectedResourceMetadata(mockReq("b.trycloudflare.com"));
    expect(a.resource).not.toBe(b.resource);
    expect(a.authorization_servers).not.toEqual(b.authorization_servers);
  });

  it("local host stays http (dev)", () => {
    const m = buildProtectedResourceMetadata(mockReq("localhost:7423"));
    expect(m.resource).toBe("http://localhost:7423");
  });

  it("emits a schema-valid RFC 9728 document (strict)", () => {
    const m = buildProtectedResourceMetadata(mockReq("x.trycloudflare.com"));
    // .strict() schema — rejects unknown keys, so this also guards against
    // accidental field drift.
    expect(() => OAuthProtectedResourceMetadataSchema.parse(m)).not.toThrow();
  });
});
