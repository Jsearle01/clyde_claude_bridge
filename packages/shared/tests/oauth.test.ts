// T-P3-001: zod schema tests for OAuth DCR + metadata + persisted records.
// Covers Decision c (liberal-accept on DCR request) and Decision b
// (`cb_client_` prefix on persisted records).

import { describe, it, expect } from "vitest";
import {
  OAuthDcrRequestSchema,
  OAuthMetadataSchema,
  OAuthClientRecordSchema,
  OAuthClientsStoreSchema,
} from "../src/oauth.js";

describe("OAuthDcrRequestSchema (T-P3-001 Decision c: liberal-accept)", () => {
  it("accepts minimal valid request (redirect_uris only)", () => {
    const r = OAuthDcrRequestSchema.safeParse({
      redirect_uris: ["https://example.com/callback"],
    });
    expect(r.success).toBe(true);
  });

  it("accepts request with client_name", () => {
    const r = OAuthDcrRequestSchema.safeParse({
      redirect_uris: ["https://example.com/cb"],
      client_name: "My Client",
    });
    expect(r.success).toBe(true);
  });

  it("ACCEPTS unknown/extra RFC 7591 metadata (Decision c liberal-accept)", () => {
    const r = OAuthDcrRequestSchema.safeParse({
      redirect_uris: ["https://example.com/cb"],
      client_name: "x",
      // These are RFC 7591 optional metadata the daemon doesn't consume
      // yet. Must not 400.
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
      scope: "read write",
      // And totally unknown fields, also must not 400.
      future_field_we_dont_know_about: 42,
    });
    expect(r.success).toBe(true);
  });

  it("rejects missing redirect_uris", () => {
    const r = OAuthDcrRequestSchema.safeParse({ client_name: "x" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path[0]);
      expect(paths).toContain("redirect_uris");
    }
  });

  it("rejects empty redirect_uris array", () => {
    const r = OAuthDcrRequestSchema.safeParse({ redirect_uris: [] });
    expect(r.success).toBe(false);
  });

  it("rejects malformed redirect_uris (not a URL)", () => {
    const r = OAuthDcrRequestSchema.safeParse({
      redirect_uris: ["not a url"],
    });
    expect(r.success).toBe(false);
  });

  it("rejects redirect_uris of wrong shape (string not array)", () => {
    const r = OAuthDcrRequestSchema.safeParse({
      redirect_uris: "https://example.com/cb",
    });
    expect(r.success).toBe(false);
  });
});

describe("OAuthMetadataSchema (T-P3-001 Decision d: ship-only-what-we-ship)", () => {
  it("accepts the canonical shape the metadata handler produces", () => {
    const r = OAuthMetadataSchema.safeParse({
      issuer: "https://example.com",
      authorization_endpoint: "https://example.com/authorize",
      token_endpoint: "https://example.com/token",
      registration_endpoint: "https://example.com/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    });
    expect(r.success).toBe(true);
  });

  it("rejects extra fields (.strict() — never advertise capabilities we don't ship)", () => {
    const r = OAuthMetadataSchema.safeParse({
      issuer: "https://example.com",
      authorization_endpoint: "https://example.com/authorize",
      token_endpoint: "https://example.com/token",
      registration_endpoint: "https://example.com/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      revocation_endpoint: "https://example.com/revoke",
    });
    expect(r.success).toBe(false);
  });
});

describe("OAuthClientRecordSchema (T-P3-001 Decision b: cb_client_ prefix)", () => {
  it("accepts a record with cb_client_ prefix", () => {
    const r = OAuthClientRecordSchema.safeParse({
      client_id: "cb_client_" + "a".repeat(32),
      client_secret_hash: "$2a$10$" + "x".repeat(53),
      client_name: "x",
      redirect_uris: ["https://example.com/cb"],
      created_at: "2026-05-31T00:00:00.000Z",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a record without the cb_client_ prefix", () => {
    const r = OAuthClientRecordSchema.safeParse({
      client_id: "wrong_prefix_abc",
      client_secret_hash: "$2a$10$xxx",
      client_name: "x",
      redirect_uris: ["https://example.com/cb"],
      created_at: "2026-05-31T00:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an empty client_secret_hash (defensive: never persist a missing hash)", () => {
    const r = OAuthClientRecordSchema.safeParse({
      client_id: "cb_client_" + "a".repeat(32),
      client_secret_hash: "",
      client_name: "x",
      redirect_uris: ["https://example.com/cb"],
      created_at: "2026-05-31T00:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });
});

describe("OAuthClientsStoreSchema", () => {
  it("accepts empty store at version 1", () => {
    const r = OAuthClientsStoreSchema.safeParse({ version: "1", clients: [] });
    expect(r.success).toBe(true);
  });

  it("rejects version != '1' (forces explicit migration)", () => {
    const r = OAuthClientsStoreSchema.safeParse({ version: "2", clients: [] });
    expect(r.success).toBe(false);
  });
});
