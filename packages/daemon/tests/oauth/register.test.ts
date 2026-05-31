// T-P3-001: unit tests for the OAuth DCR /register endpoint. Covers
// Decision c (liberal-accept validation), Decision b (response shape with
// cb_client_ prefix), and the no-plaintext-secret-in-logs invariant.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ClientsStore } from "../../src/oauth/clients-store.js";
import { handleRegister } from "../../src/oauth/register.js";
import type { Logger } from "../../src/log/logger.js";

interface LoggedEntry {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  extra?: Record<string, unknown>;
}

function makeRecordingLogger(): { logger: Logger; entries: LoggedEntry[] } {
  const entries: LoggedEntry[] = [];
  const logger: Logger = {
    debug: (msg, extra) => entries.push({ level: "debug", msg, extra }),
    info: (msg, extra) => entries.push({ level: "info", msg, extra }),
    warn: (msg, extra) => entries.push({ level: "warn", msg, extra }),
    error: (msg, extra) => entries.push({ level: "error", msg, extra }),
    close: () => Promise.resolve(),
  };
  return { logger, entries };
}

// Minimal IncomingMessage stand-in that streams a fixed body via event
// emission. Vitest's spy + small EventEmitter-like fakery is sufficient
// for our handler's body-read path.
function makeReq(opts: {
  method: string;
  body?: string;
}): IncomingMessage {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const req = {
    method: opts.method,
    headers: { host: "test.local" },
    on(event: string, cb: (...args: unknown[]) => void): IncomingMessage {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
      // Once both `data` and `end` are subscribed, fire them.
      queueMicrotask(() => {
        if (
          listeners.has("data") &&
          listeners.has("end") &&
          !req._fired
        ) {
          req._fired = true;
          if (opts.body !== undefined) {
            for (const l of listeners.get("data") ?? []) {
              l(Buffer.from(opts.body, "utf8"));
            }
          }
          for (const l of listeners.get("end") ?? []) {
            l();
          }
        }
      });
      return req as unknown as IncomingMessage;
    },
    destroy(): void {
      // no-op for tests
    },
    _fired: false,
  };
  return req as unknown as IncomingMessage;
}

interface RecordedResponse {
  status?: number;
  headers?: Record<string, string | number>;
  body?: string;
}

function makeRes(rec: RecordedResponse): ServerResponse {
  const res = {
    writeHead(status: number, headers?: Record<string, string | number>): ServerResponse {
      rec.status = status;
      rec.headers = headers;
      return res as unknown as ServerResponse;
    },
    end(body?: string): void {
      rec.body = body;
    },
    headersSent: false,
  };
  return res as unknown as ServerResponse;
}

let tempDir: string;
let store: ClientsStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cb-dcr-"));
  store = new ClientsStore(join(tempDir, "clients.json"));
  await store.load();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("handleRegister — happy path (T-P3-001 Decision b + c)", () => {
  it("registers a client; 201 Created; response carries cb_client_ id + plaintext secret + echoed metadata", async () => {
    const rec: RecordedResponse = {};
    const { logger } = makeRecordingLogger();
    await handleRegister(
      makeReq({
        method: "POST",
        body: JSON.stringify({
          redirect_uris: ["https://example.com/cb"],
          client_name: "MyClient",
        }),
      }),
      makeRes(rec),
      { logger, clientsStore: store },
    );

    expect(rec.status).toBe(201);
    const body = JSON.parse(rec.body ?? "{}") as {
      client_id: string;
      client_secret: string;
      client_name: string;
      redirect_uris: string[];
      grant_types: string[];
      response_types: string[];
      token_endpoint_auth_method: string;
    };
    expect(body.client_id.startsWith("cb_client_")).toBe(true);
    expect(body.client_secret).toMatch(/^[a-f0-9]{64}$/);
    expect(body.client_name).toBe("MyClient");
    expect(body.redirect_uris).toEqual(["https://example.com/cb"]);
    // Echoed capabilities per Decision d
    expect(body.grant_types).toEqual(["authorization_code"]);
    expect(body.response_types).toEqual(["code"]);
    expect(body.token_endpoint_auth_method).toBe("client_secret_post");

    // Persisted record exists and has the hash, not the plaintext.
    const persisted = store.findByClientId(body.client_id);
    expect(persisted).not.toBeNull();
    expect(persisted?.client_secret_hash).toMatch(/^\$2[ab]\$/);
    expect(persisted?.client_secret_hash).not.toBe(body.client_secret);
  });

  it("defaults client_name to 'unnamed-client' when absent", async () => {
    const rec: RecordedResponse = {};
    const { logger } = makeRecordingLogger();
    await handleRegister(
      makeReq({
        method: "POST",
        body: JSON.stringify({
          redirect_uris: ["https://example.com/cb"],
        }),
      }),
      makeRes(rec),
      { logger, clientsStore: store },
    );
    const body = JSON.parse(rec.body ?? "{}") as { client_name: string };
    expect(body.client_name).toBe("unnamed-client");
  });

  it("accepts extra RFC 7591 fields without 400 (Decision c liberal-accept)", async () => {
    const rec: RecordedResponse = {};
    const { logger } = makeRecordingLogger();
    await handleRegister(
      makeReq({
        method: "POST",
        body: JSON.stringify({
          redirect_uris: ["https://example.com/cb"],
          client_name: "x",
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_post",
          scope: "read",
          // Even totally unknown fields must pass through.
          future_field: { nested: 1 },
        }),
      }),
      makeRes(rec),
      { logger, clientsStore: store },
    );
    expect(rec.status).toBe(201);
  });

  it("does NOT log plaintext secret (security invariant: hash only at rest, plaintext only in response body)", async () => {
    const rec: RecordedResponse = {};
    const { logger, entries } = makeRecordingLogger();
    await handleRegister(
      makeReq({
        method: "POST",
        body: JSON.stringify({
          redirect_uris: ["https://example.com/cb"],
          client_name: "x",
        }),
      }),
      makeRes(rec),
      { logger, clientsStore: store },
    );
    const body = JSON.parse(rec.body ?? "{}") as { client_secret: string };
    const plaintextSecret = body.client_secret;
    expect(plaintextSecret).toMatch(/^[a-f0-9]{64}$/);
    for (const entry of entries) {
      const stringified = JSON.stringify(entry);
      expect(stringified).not.toContain(plaintextSecret);
    }
  });
});

describe("handleRegister — rejections (T-P3-001 Decision c: strict on the two fields we consume)", () => {
  it("400 invalid_request on non-POST method", async () => {
    const rec: RecordedResponse = {};
    const { logger } = makeRecordingLogger();
    await handleRegister(
      makeReq({ method: "GET" }),
      makeRes(rec),
      { logger, clientsStore: store },
    );
    expect(rec.status).toBe(405);
  });

  it("400 invalid_request on malformed JSON", async () => {
    const rec: RecordedResponse = {};
    const { logger } = makeRecordingLogger();
    await handleRegister(
      makeReq({ method: "POST", body: "{ not json" }),
      makeRes(rec),
      { logger, clientsStore: store },
    );
    expect(rec.status).toBe(400);
    const body = JSON.parse(rec.body ?? "{}") as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("400 invalid_redirect_uri on missing redirect_uris", async () => {
    const rec: RecordedResponse = {};
    const { logger } = makeRecordingLogger();
    await handleRegister(
      makeReq({
        method: "POST",
        body: JSON.stringify({ client_name: "x" }),
      }),
      makeRes(rec),
      { logger, clientsStore: store },
    );
    expect(rec.status).toBe(400);
    const body = JSON.parse(rec.body ?? "{}") as { error: string };
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("400 invalid_redirect_uri on empty redirect_uris array", async () => {
    const rec: RecordedResponse = {};
    const { logger } = makeRecordingLogger();
    await handleRegister(
      makeReq({
        method: "POST",
        body: JSON.stringify({ redirect_uris: [], client_name: "x" }),
      }),
      makeRes(rec),
      { logger, clientsStore: store },
    );
    expect(rec.status).toBe(400);
    const body = JSON.parse(rec.body ?? "{}") as { error: string };
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("400 invalid_redirect_uri on malformed URI string", async () => {
    const rec: RecordedResponse = {};
    const { logger } = makeRecordingLogger();
    await handleRegister(
      makeReq({
        method: "POST",
        body: JSON.stringify({
          redirect_uris: ["not a url"],
          client_name: "x",
        }),
      }),
      makeRes(rec),
      { logger, clientsStore: store },
    );
    expect(rec.status).toBe(400);
  });
});

describe("handleRegister — clients.json file shape (T-P3-001 C-25.1 evidence)", () => {
  it("on-disk clients.json contains version:'1' + clients array with hash-only secret field", async () => {
    const rec: RecordedResponse = {};
    const { logger } = makeRecordingLogger();
    await handleRegister(
      makeReq({
        method: "POST",
        body: JSON.stringify({
          redirect_uris: ["https://example.com/cb"],
          client_name: "fileshape",
        }),
      }),
      makeRes(rec),
      { logger, clientsStore: store },
    );
    const raw = await readFile(
      join(tempDir, "clients.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      version: string;
      clients: Array<Record<string, unknown>>;
    };
    expect(parsed.version).toBe("1");
    expect(parsed.clients).toHaveLength(1);
    const entry = parsed.clients[0];
    expect(entry?.client_id).toMatch(/^cb_client_[a-f0-9]{32}$/);
    expect(entry?.client_secret_hash).toMatch(/^\$2[ab]\$/);
    expect(entry?.client_name).toBe("fileshape");
    expect(entry?.redirect_uris).toEqual(["https://example.com/cb"]);
    expect(typeof entry?.created_at).toBe("string");
    // Crucial: no `client_secret` key (only `client_secret_hash`).
    expect(entry?.client_secret).toBeUndefined();
  });
});
