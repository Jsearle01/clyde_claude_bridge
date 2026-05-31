// T-P3-001: integration test for the OAuth bootstrap router. Verifies
// that both endpoints are reachable without auth (the router is consulted
// BEFORE McpServer's Bearer check) and that non-OAuth paths fall through.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ClientsStore } from "../../src/oauth/clients-store.js";
import { makeOAuthRouter } from "../../src/oauth/router.js";
import type { Logger } from "../../src/log/logger.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

function makeReq(opts: {
  method: string;
  url: string;
  host?: string;
  body?: string;
}): IncomingMessage {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const req = {
    method: opts.method,
    url: opts.url,
    headers: { host: opts.host ?? "test.local" },
    on(event: string, cb: (...args: unknown[]) => void): IncomingMessage {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
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
      // no-op
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
let router: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cb-oauth-router-"));
  store = new ClientsStore(join(tempDir, "clients.json"));
  await store.load();
  router = makeOAuthRouter({ logger: silentLogger, clientsStore: store });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("OAuth router integration (T-P3-001 unauthenticated bootstrap)", () => {
  it("routes /.well-known/oauth-authorization-server → metadata; returns true", async () => {
    const rec: RecordedResponse = {};
    const req = makeReq({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
      host: "tunnel.trycloudflare.com",
    });
    const handled = await router(req, makeRes(rec));
    expect(handled).toBe(true);
    expect(rec.status).toBe(200);
    const body = JSON.parse(rec.body ?? "{}") as { issuer: string };
    expect(body.issuer).toBe("https://tunnel.trycloudflare.com");
  });

  it("routes /register → DCR; returns true", async () => {
    const rec: RecordedResponse = {};
    const req = makeReq({
      method: "POST",
      url: "/register",
      body: JSON.stringify({
        redirect_uris: ["https://example.com/cb"],
        client_name: "router-test",
      }),
    });
    const handled = await router(req, makeRes(rec));
    expect(handled).toBe(true);
    expect(rec.status).toBe(201);
  });

  it("returns false for non-OAuth paths (fall-through to MCP)", async () => {
    const rec: RecordedResponse = {};
    const req = makeReq({ method: "POST", url: "/mcp" });
    const handled = await router(req, makeRes(rec));
    expect(handled).toBe(false);
    // No response written
    expect(rec.status).toBeUndefined();
  });

  it("strips query string before matching (defensive)", async () => {
    const rec: RecordedResponse = {};
    const req = makeReq({
      method: "GET",
      url: "/.well-known/oauth-authorization-server?foo=bar",
      host: "x.trycloudflare.com",
    });
    const handled = await router(req, makeRes(rec));
    expect(handled).toBe(true);
    expect(rec.status).toBe(200);
  });

  it("end-to-end: register → metadata response references the same issuer host", async () => {
    // Register
    const regRec: RecordedResponse = {};
    await router(
      makeReq({
        method: "POST",
        url: "/register",
        host: "abc.trycloudflare.com",
        body: JSON.stringify({
          redirect_uris: ["https://example.com/cb"],
          client_name: "end-to-end",
        }),
      }),
      makeRes(regRec),
    );
    const regBody = JSON.parse(regRec.body ?? "{}") as { client_id: string };

    // Now fetch metadata at the same host — same issuer
    const metaRec: RecordedResponse = {};
    await router(
      makeReq({
        method: "GET",
        url: "/.well-known/oauth-authorization-server",
        host: "abc.trycloudflare.com",
      }),
      makeRes(metaRec),
    );
    const metaBody = JSON.parse(metaRec.body ?? "{}") as { issuer: string };

    // The registered client persisted; metadata's registration_endpoint
    // matches the URL the client just used.
    expect(store.findByClientId(regBody.client_id)).not.toBeNull();
    expect(metaBody.issuer).toBe("https://abc.trycloudflare.com");
  });
});

// ===========================================================================
// T-P3-002 — extended router (3 OAuth paths now: metadata + register +
// authorize family). Negative tests confirm non-OAuth paths still fall
// through, satisfying the verdict §1 anchored-matching invariant.
// ===========================================================================

import { ConsentManager } from "../../src/oauth/consent.js";
import { makeOAuthRouter } from "../../src/oauth/router.js";

let extendedRouter:
  | ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>)
  | undefined;
let consentManager: ConsentManager | undefined;

describe("OAuth router — T-P3-002 extended (authorize + status + negative paths)", () => {
  beforeEach(async () => {
    consentManager = new ConsentManager(
      { logger: silentLogger },
      () => 1,
      () => undefined,
    );
    extendedRouter = makeOAuthRouter({
      logger: silentLogger,
      clientsStore: store,
      consentManager,
    });
    // Register a client so /authorize has a target.
    await store.addClient({
      client_name: "Router T-P3-002 client",
      redirect_uris: ["https://example.com/cb"],
    });
  });

  afterEach(() => {
    consentManager?.stop();
  });

  it("routes /authorize (with consent manager wired) → returns true", async () => {
    // Schedule an immediate ack so authorize doesn't hang waiting.
    const list = store.list();
    const client_id = list[list.length - 1]?.client_id ?? "";
    const ackInterceptor = new ConsentManager(
      { logger: silentLogger },
      (msg) => {
        // Ack immediately so the test resolves fast.
        queueMicrotask(() => ackInterceptor.recordAck(msg.request_id));
        return 1;
      },
      () => undefined,
    );
    const routerWithIntercept = makeOAuthRouter({
      logger: silentLogger,
      clientsStore: store,
      consentManager: ackInterceptor,
    });
    const rec: RecordedResponse = {};
    const q = new URLSearchParams({
      client_id,
      redirect_uri: "https://example.com/cb",
      response_type: "code",
      code_challenge: "x",
      code_challenge_method: "S256",
      state: "s",
    });
    const handled = await routerWithIntercept(
      makeReq({ method: "GET", url: `/authorize?${q.toString()}` }),
      makeRes(rec),
    );
    expect(handled).toBe(true);
    expect(rec.status).toBe(200);
    expect(rec.body).toContain("Authorizing");
    ackInterceptor.stop();
  });

  it("routes /authorize/status → returns true (404 page for unknown request_id)", async () => {
    if (extendedRouter === undefined) throw new Error("router missing");
    const rec: RecordedResponse = {};
    const handled = await extendedRouter(
      makeReq({ method: "GET", url: "/authorize/status?request_id=unknown" }),
      makeRes(rec),
    );
    expect(handled).toBe(true);
    expect(rec.status).toBe(404);
  });

  it("does NOT route /authorize when consent manager is omitted from deps (defensive)", async () => {
    const minimalRouter = makeOAuthRouter({
      logger: silentLogger,
      clientsStore: store,
      // consentManager omitted
    });
    const rec: RecordedResponse = {};
    const handled = await minimalRouter(
      makeReq({ method: "GET", url: "/authorize?client_id=x" }),
      makeRes(rec),
    );
    expect(handled).toBe(false);
    expect(rec.status).toBeUndefined();
  });

  it("negative: /mcp does NOT short-circuit (falls through to MCP layer)", async () => {
    if (extendedRouter === undefined) throw new Error("router missing");
    const rec: RecordedResponse = {};
    const handled = await extendedRouter(
      makeReq({ method: "POST", url: "/mcp" }),
      makeRes(rec),
    );
    expect(handled).toBe(false);
    expect(rec.status).toBeUndefined();
  });

  it("negative: /authorize-look-alike does NOT short-circuit (anchored exact-match)", async () => {
    if (extendedRouter === undefined) throw new Error("router missing");
    const rec: RecordedResponse = {};
    const handled = await extendedRouter(
      makeReq({ method: "GET", url: "/authorize-extra" }),
      makeRes(rec),
    );
    expect(handled).toBe(false);
  });

  it("negative: /register-other does NOT short-circuit (anchored exact-match)", async () => {
    if (extendedRouter === undefined) throw new Error("router missing");
    const rec: RecordedResponse = {};
    const handled = await extendedRouter(
      makeReq({ method: "POST", url: "/register-other" }),
      makeRes(rec),
    );
    expect(handled).toBe(false);
  });

  it("negative: /authorize/status/extra does NOT short-circuit (anchored exact-match)", async () => {
    if (extendedRouter === undefined) throw new Error("router missing");
    const rec: RecordedResponse = {};
    const handled = await extendedRouter(
      makeReq({ method: "GET", url: "/authorize/status/extra" }),
      makeRes(rec),
    );
    expect(handled).toBe(false);
  });

  it("strips query string before matching authorize/status (defensive)", async () => {
    if (extendedRouter === undefined) throw new Error("router missing");
    const rec: RecordedResponse = {};
    const handled = await extendedRouter(
      makeReq({
        method: "GET",
        url: "/authorize/status?request_id=foo&extra=bar",
      }),
      makeRes(rec),
    );
    expect(handled).toBe(true);
    expect(rec.status).toBe(404); // unknown request_id, but routed
  });
});
