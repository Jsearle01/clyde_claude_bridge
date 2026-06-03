// T-P3-001: OAuth Dynamic Client Registration (RFC 7591) + Authorization
// Server Metadata (RFC 8414) schemas.
//
// Decision c (T-P3-001 dispatch): liberal-accept on DCR — strict on the
// two fields the daemon consumes (`redirect_uris`, `client_name`),
// permissive on all other RFC 7591 optional metadata (`grant_types`,
// `response_types`, `token_endpoint_auth_method`, `scope`, ...). Do NOT
// 400 on unknown fields. Rationale: claude.ai's DCR client shape is
// unmapped (C-21); over-strict rejection is the most likely failure mode
// for AC-P3-12 live smoke.

import { z } from "zod";

// RFC 3986 URI shape — pragmatic check (z.url is strict on http(s); DCR
// allows custom schemes for native clients but we only need http/https
// for claude.ai's connector path). The check is liberal enough that the
// validation surface stays narrow (just "non-empty array of valid URLs").
const RedirectUriSchema = z.string().url();

// DCR request — RFC 7591 §2. `.passthrough()` accepts unknown fields
// without 400-ing (Decision c). `redirect_uris` required and non-empty;
// `client_name` optional with a sensible default applied at handler.
export const OAuthDcrRequestSchema = z
  .object({
    redirect_uris: z.array(RedirectUriSchema).min(1),
    client_name: z.string().min(1).optional(),
  })
  .passthrough();

export type OAuthDcrRequest = z.infer<typeof OAuthDcrRequestSchema>;

// DCR response — RFC 7591 §3.2.1. Echoes back what the server stored
// (per design §3.3 record shape: client_id + redirect_uris + client_name
// + created_at) plus the one-time plaintext `client_secret`. Per Decision
// b: `client_id` uses `cb_client_` prefix.
export const OAuthDcrResponseSchema = z
  .object({
    client_id: z.string(),
    client_secret: z.string(),
    client_id_issued_at: z.number().int(),
    client_name: z.string(),
    redirect_uris: z.array(z.string()),
    // Echoed metadata so clients can introspect; we hardcode these to the
    // capabilities the daemon supports (Decision d).
    grant_types: z.array(z.string()),
    response_types: z.array(z.string()),
    token_endpoint_auth_method: z.string(),
  })
  .strict();

export type OAuthDcrResponse = z.infer<typeof OAuthDcrResponseSchema>;

// Authorization Server Metadata — RFC 8414. URLs are constructed at
// request time from the inbound `Host` header (design §5 — tunnel URL
// rotates; never bake in a fixed origin). Per Decision d: advertise only
// what we ship.
export const OAuthMetadataSchema = z
  .object({
    issuer: z.string(),
    authorization_endpoint: z.string(),
    token_endpoint: z.string(),
    registration_endpoint: z.string(),
    response_types_supported: z.array(z.string()),
    grant_types_supported: z.array(z.string()),
    code_challenge_methods_supported: z.array(z.string()),
    token_endpoint_auth_methods_supported: z.array(z.string()),
  })
  .strict();

export type OAuthMetadata = z.infer<typeof OAuthMetadataSchema>;

// Persisted client record (clients.json entry) — design §3.3. The
// plaintext `client_secret` is NEVER stored; `client_secret_hash` is the
// bcryptjs hash (Decision a).
export const OAuthClientRecordSchema = z
  .object({
    client_id: z.string().regex(/^cb_client_/),
    client_secret_hash: z.string().min(1),
    client_name: z.string().min(1),
    redirect_uris: z.array(z.string()).min(1),
    created_at: z.string(),
  })
  .strict();

export type OAuthClientRecord = z.infer<typeof OAuthClientRecordSchema>;

export const OAuthClientsStoreSchema = z
  .object({
    version: z.literal("1"),
    clients: z.array(OAuthClientRecordSchema),
  })
  .strict();

export type OAuthClientsStore = z.infer<typeof OAuthClientsStoreSchema>;

// T-P3-005: per-operation approval granularity. Selected by the operator
// at handoff and relayed on the delegate call; the token may carry a
// non-null DEFAULT. Resolution (at the gate): operation → binding default →
// per_call fail-safe.
//   per_call — gate every gated step (watch closely).
//   task     — approve once, then the operation runs (reuses the runtime
//              session-bypass mechanic).
//   auto     — no discretionary delegation prompt. (At T-P3-005 this only
//              governs the existing prompt; the always-gate floor `auto`
//              runs within is T-P3-006 — `auto` is NOT "never stops".)
export const OperationGranularitySchema = z.enum([
  "per_call",
  "task",
  "auto",
]);
export type OperationGranularity = z.infer<typeof OperationGranularitySchema>;

// T-P3-004a: persisted access-token record (tokens.json entry). The
// durable home for the workspace binding. The plaintext token is NEVER
// stored — `token_hash` is its SHA-256 (fast per-request lookup; a 32-byte
// random token has no brute-force concern, unlike a client_secret which
// uses bcrypt). `bound_workspace` is the workspace identifier the token may
// act on (null = a non-binding approve, which enforcement treats as
// act-on-nothing). `granularity` is reserved for T-P3-005 (null here).
export const OAuthTokenRecordSchema = z
  .object({
    token_hash: z.string().min(1),
    client_id: z.string().min(1),
    bound_workspace: z.string().nullable(),
    // T-P3-005: the binding's DEFAULT granularity (enum-or-null; null =
    // unspecified → the gate falls through to its per_call fail-safe).
    granularity: OperationGranularitySchema.nullable(),
    issued_at: z.string(),
    // Epoch milliseconds; expired tokens are rejected + swept.
    expires_at: z.number().int(),
  })
  .strict();

export type OAuthTokenRecord = z.infer<typeof OAuthTokenRecordSchema>;

export const OAuthTokensStoreSchema = z
  .object({
    version: z.literal("1"),
    tokens: z.array(OAuthTokenRecordSchema),
  })
  .strict();

export type OAuthTokensStore = z.infer<typeof OAuthTokensStoreSchema>;
