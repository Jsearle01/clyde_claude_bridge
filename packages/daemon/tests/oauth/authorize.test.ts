// T-P3-002: unit tests for /authorize gating + ack-window + offline path.
// Stub ConsentManager so we can drive ack/decision deterministically.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ClientsStore } from "../../src/oauth/clients-store.js";
import { ConsentManager } from "../../src/oauth/consent.js";
import { handleAuthorize } from "../../src/oauth/authorize.js";
import type { Logger } from "../../src/log/logger.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

function makeReq(opts: {
  method?: string;
  url: string;
  host?: string;
}): IncomingMessage {
  const req: Partial<IncomingMessage> = {
    method: opts.method ?? "GET",
    url: opts.url,
    headers: { host: opts.host ?? "tunnel.test" },
  };
  // The authorize handler doesn't consume the body, but the IncomingMessage
  // interface requires `on` for event subscription. Return a self-referencing
  // mock that no-ops.
  Object.assign(req, {
    on(): IncomingMessage {
      return req as IncomingMessage;
    },
  });
  return req as IncomingMessage;
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
let manager: ConsentManager;
let registeredClientId: string;
let registeredRedirectUri: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cb-authorize-"));
  store = new ClientsStore(join(tempDir, "clients.json"));
  await store.load();
  const { record } = await store.addClient({
    client_name: "Test Client",
    redirect_uris: [
      "https://example.com/cb",
      "https://example.com/cb-alt",
    ],
  });
  registeredClientId = record.client_id;
  registeredRedirectUri = "https://example.com/cb";
  manager = new ConsentManager(
    { logger: silentLogger },
    () => ({ delivered: 1, totalActive: 1 }), // one unbound extension online
    () => undefined,
  );
});

afterEach(async () => {
  manager.stop();
  vi.useRealTimers();
  await rm(tempDir, { recursive: true, force: true });
});

function buildAuthorizeUrl(params: Record<string, string>): string {
  const q = new URLSearchParams(params);
  return `/authorize?${q.toString()}`;
}

describe("handleAuthorize — RFC 6749 §4.1 gating", () => {
  it("405 on non-GET", async () => {
    const rec: RecordedResponse = {};
    await handleAuthorize(
      makeReq({ method: "POST", url: "/authorize" }),
      makeRes(rec),
      { logger: silentLogger, clientsStore: store, consentManager: manager },
    );
    expect(rec.status).toBe(405);
  });

  it("400 unsupported_response_type when response_type != 'code'", async () => {
    const rec: RecordedResponse = {};
    await handleAuthorize(
      makeReq({
        url: buildAuthorizeUrl({
          client_id: registeredClientId,
          redirect_uri: registeredRedirectUri,
          response_type: "token", // implicit flow — not supported
          code_challenge: "x",
          code_challenge_method: "S256",
          state: "s",
        }),
      }),
      makeRes(rec),
      { logger: silentLogger, clientsStore: store, consentManager: manager },
    );
    expect(rec.status).toBe(400);
    const body = JSON.parse(rec.body ?? "{}") as { error: string };
    expect(body.error).toBe("unsupported_response_type");
  });

  it("400 invalid_request when client_id is missing", async () => {
    const rec: RecordedResponse = {};
    await handleAuthorize(
      makeReq({
        url: buildAuthorizeUrl({
          redirect_uri: registeredRedirectUri,
          response_type: "code",
          code_challenge: "x",
          code_challenge_method: "S256",
          state: "s",
        }),
      }),
      makeRes(rec),
      { logger: silentLogger, clientsStore: store, consentManager: manager },
    );
    expect(rec.status).toBe(400);
    const body = JSON.parse(rec.body ?? "{}") as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("400 invalid_client when client_id is not registered", async () => {
    const rec: RecordedResponse = {};
    await handleAuthorize(
      makeReq({
        url: buildAuthorizeUrl({
          client_id: "cb_client_unknown",
          redirect_uri: registeredRedirectUri,
          response_type: "code",
          code_challenge: "x",
          code_challenge_method: "S256",
          state: "s",
        }),
      }),
      makeRes(rec),
      { logger: silentLogger, clientsStore: store, consentManager: manager },
    );
    expect(rec.status).toBe(400);
    const body = JSON.parse(rec.body ?? "{}") as { error: string };
    expect(body.error).toBe("invalid_client");
  });

  it("400 invalid_redirect_uri when redirect_uri is NOT an exact registered match (open-redirect guard)", async () => {
    const rec: RecordedResponse = {};
    await handleAuthorize(
      makeReq({
        url: buildAuthorizeUrl({
          client_id: registeredClientId,
          redirect_uri: "https://attacker.com/cb", // not registered
          response_type: "code",
          code_challenge: "x",
          code_challenge_method: "S256",
          state: "s",
        }),
      }),
      makeRes(rec),
      { logger: silentLogger, clientsStore: store, consentManager: manager },
    );
    expect(rec.status).toBe(400);
    const body = JSON.parse(rec.body ?? "{}") as { error: string };
    expect(body.error).toBe("invalid_redirect_uri");
    // Critical: NO consent record was created (gating happens BEFORE
    // beginConsent), so no IPC fired, no auth code was issued.
    expect(manager.size().consents).toBe(0);
    expect(manager.size().auth_codes).toBe(0);
  });

  it("400 invalid_redirect_uri on extra path under a registered URI (substring is not enough)", async () => {
    const rec: RecordedResponse = {};
    await handleAuthorize(
      makeReq({
        url: buildAuthorizeUrl({
          client_id: registeredClientId,
          redirect_uri: "https://example.com/cb/extra", // prefix-of-registered isn't enough
          response_type: "code",
          code_challenge: "x",
          code_challenge_method: "S256",
          state: "s",
        }),
      }),
      makeRes(rec),
      { logger: silentLogger, clientsStore: store, consentManager: manager },
    );
    expect(rec.status).toBe(400);
  });

  it("400 invalid_request when code_challenge is missing (PKCE required)", async () => {
    const rec: RecordedResponse = {};
    await handleAuthorize(
      makeReq({
        url: buildAuthorizeUrl({
          client_id: registeredClientId,
          redirect_uri: registeredRedirectUri,
          response_type: "code",
          code_challenge_method: "S256",
          state: "s",
        }),
      }),
      makeRes(rec),
      { logger: silentLogger, clientsStore: store, consentManager: manager },
    );
    expect(rec.status).toBe(400);
    const body = JSON.parse(rec.body ?? "{}") as { error: string };
    expect(body.error).toBe("invalid_request");
    expect(body).toHaveProperty("error_description");
  });

  it("400 invalid_request when code_challenge_method='plain' (S256-only per Decision d)", async () => {
    const rec: RecordedResponse = {};
    await handleAuthorize(
      makeReq({
        url: buildAuthorizeUrl({
          client_id: registeredClientId,
          redirect_uri: registeredRedirectUri,
          response_type: "code",
          code_challenge: "x",
          code_challenge_method: "plain",
          state: "s",
        }),
      }),
      makeRes(rec),
      { logger: silentLogger, clientsStore: store, consentManager: manager },
    );
    expect(rec.status).toBe(400);
  });

  it("400 invalid_request when code_challenge_method is missing", async () => {
    const rec: RecordedResponse = {};
    await handleAuthorize(
      makeReq({
        url: buildAuthorizeUrl({
          client_id: registeredClientId,
          redirect_uri: registeredRedirectUri,
          response_type: "code",
          code_challenge: "x",
          state: "s",
        }),
      }),
      makeRes(rec),
      { logger: silentLogger, clientsStore: store, consentManager: manager },
    );
    expect(rec.status).toBe(400);
  });
});

describe("handleAuthorize — extension-offline guardrail (AC-P3-4)", () => {
  it("503 extension-offline HTML when no extension is connected; NO IPC fired; NO consent record created", async () => {
    // Reconfigure manager to have 0 recipients AND 0 active (truly offline).
    const offlineManager = new ConsentManager(
      { logger: silentLogger },
      () => ({ delivered: 0, totalActive: 0 }), // no extensions online
      () => undefined,
    );
    const rec: RecordedResponse = {};
    await handleAuthorize(
      makeReq({
        url: buildAuthorizeUrl({
          client_id: registeredClientId,
          redirect_uri: registeredRedirectUri,
          response_type: "code",
          code_challenge: "x",
          code_challenge_method: "S256",
          state: "s",
        }),
      }),
      makeRes(rec),
      {
        logger: silentLogger,
        clientsStore: store,
        consentManager: offlineManager,
      },
    );
    expect(rec.status).toBe(503);
    expect(rec.headers?.["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(rec.body).toContain("No VS Code extension is connected");
    expect(offlineManager.size().consents).toBe(0);
    offlineManager.stop();
  });
});

describe("handleAuthorize — ack-timeout (AC-P3-6)", () => {
  it("504 ack-timeout HTML when extension never acks within 3s", async () => {
    vi.useFakeTimers();
    const rec: RecordedResponse = {};
    const promise = handleAuthorize(
      makeReq({
        url: buildAuthorizeUrl({
          client_id: registeredClientId,
          redirect_uri: registeredRedirectUri,
          response_type: "code",
          code_challenge: "x",
          code_challenge_method: "S256",
          state: "s",
        }),
      }),
      makeRes(rec),
      { logger: silentLogger, clientsStore: store, consentManager: manager },
    );
    // Advance past the 3s ack window.
    await vi.advanceTimersByTimeAsync(3100);
    await promise;
    expect(rec.status).toBe(504);
    expect(rec.body).toContain("didn't acknowledge within 3 seconds");
  });
});

describe("handleAuthorize — pending-page happy path", () => {
  it("200 pending HTML with meta-refresh to /authorize/status when ack arrives", async () => {
    // Get the request_id by intercepting beginConsent.
    let observedRequestId: string | undefined;
    const interceptingManager = new ConsentManager(
      { logger: silentLogger },
      (msg) => {
        observedRequestId = msg.request_id;
        return { delivered: 1, totalActive: 1 };
      },
      () => undefined,
    );
    // Schedule an ack to arrive just after authorize starts awaiting it.
    queueMicrotask(() => {
      if (observedRequestId !== undefined) {
        interceptingManager.recordAck(observedRequestId);
      }
    });
    const rec: RecordedResponse = {};
    await handleAuthorize(
      makeReq({
        host: "tunnel.test",
        url: buildAuthorizeUrl({
          client_id: registeredClientId,
          redirect_uri: registeredRedirectUri,
          response_type: "code",
          code_challenge: "x",
          code_challenge_method: "S256",
          state: "s",
        }),
      }),
      makeRes(rec),
      {
        logger: silentLogger,
        clientsStore: store,
        consentManager: interceptingManager,
      },
    );
    expect(rec.status).toBe(200);
    expect(rec.body).toContain("Authorizing Test Client");
    expect(rec.body).toContain("meta http-equiv=\"refresh\"");
    expect(rec.body).toContain("/authorize/status?request_id=");
    expect(rec.body).toContain("https://tunnel.test"); // Host-derived URL
    interceptingManager.stop();
  });
});
