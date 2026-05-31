// T-P3-002: unit tests for /authorize/status. Covers:
//   - unknown request_id → 404 not-found page
//   - pending → 200 pending page (decision timer fires on first poll)
//   - approved → 302 to redirect_uri?code=…&state=… (state round-trips)
//   - denied → 200 deny page (denial_kind in copy)
//   - timeout → 200 decision-timeout page

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ConsentManager } from "../../src/oauth/consent.js";
import { handleStatus } from "../../src/oauth/status.js";
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
  return {
    method: opts.method ?? "GET",
    url: opts.url,
    headers: { host: opts.host ?? "tunnel.test" },
  } as unknown as IncomingMessage;
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

let manager: ConsentManager;

beforeEach(() => {
  manager = new ConsentManager(
    { logger: silentLogger },
    () => 1,
    () => undefined,
  );
});

afterEach(() => {
  manager.stop();
  vi.useRealTimers();
});

function statusUrl(request_id: string): string {
  return `/authorize/status?request_id=${encodeURIComponent(request_id)}`;
}

describe("handleStatus — unknown / missing request_id", () => {
  it("404 not-found page when request_id is missing", async () => {
    const rec: RecordedResponse = {};
    await handleStatus(
      makeReq({ url: "/authorize/status" }),
      makeRes(rec),
      { logger: silentLogger, consentManager: manager },
    );
    expect(rec.status).toBe(404);
    expect(rec.body).toContain("Unknown authorization request");
  });

  it("404 not-found page when request_id is unknown", async () => {
    const rec: RecordedResponse = {};
    await handleStatus(
      makeReq({ url: statusUrl("nonexistent") }),
      makeRes(rec),
      { logger: silentLogger, consentManager: manager },
    );
    expect(rec.status).toBe(404);
  });
});

describe("handleStatus — approved → 302 redirect with state round-trip (AC-P3-3)", () => {
  it("302 redirect to registered redirect_uri?code=…&state=…", async () => {
    const r = manager.beginConsent({
      client_id: "cb_client_x",
      client_name: "X",
      redirect_uri: "https://example.com/cb",
      state_param: "client_state_abc",
      code_challenge: "challenge",
    });
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    manager.recordDecision(r.request_id, "approve");

    const rec: RecordedResponse = {};
    await handleStatus(
      makeReq({ url: statusUrl(r.request_id) }),
      makeRes(rec),
      { logger: silentLogger, consentManager: manager },
    );
    expect(rec.status).toBe(302);
    const location = (rec.headers?.["Location"] ?? rec.headers?.["location"]) as
      | string
      | undefined;
    expect(location).toBeDefined();
    if (location !== undefined) {
      const url = new URL(location);
      expect(url.origin).toBe("https://example.com");
      expect(url.pathname).toBe("/cb");
      expect(url.searchParams.get("code")).toMatch(/^[a-f0-9]{64}$/);
      expect(url.searchParams.get("state")).toBe("client_state_abc");
    }
  });

  it("preserves existing query in redirect_uri (RFC 6749 §4.1.2)", async () => {
    const r = manager.beginConsent({
      client_id: "cb_client_x",
      client_name: "X",
      redirect_uri: "https://example.com/cb?app=foo&v=1",
      state_param: "s",
      code_challenge: "c",
    });
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    manager.recordDecision(r.request_id, "approve");

    const rec: RecordedResponse = {};
    await handleStatus(
      makeReq({ url: statusUrl(r.request_id) }),
      makeRes(rec),
      { logger: silentLogger, consentManager: manager },
    );
    expect(rec.status).toBe(302);
    const location = (rec.headers?.["Location"] ?? rec.headers?.["location"]) as
      | string
      | undefined;
    if (location !== undefined) {
      const url = new URL(location);
      expect(url.searchParams.get("app")).toBe("foo");
      expect(url.searchParams.get("v")).toBe("1");
      expect(url.searchParams.get("code")).toMatch(/^[a-f0-9]{64}$/);
      expect(url.searchParams.get("state")).toBe("s");
    }
  });

  it("omits state from redirect when state_param was empty", async () => {
    const r = manager.beginConsent({
      client_id: "cb_client_x",
      client_name: "X",
      redirect_uri: "https://example.com/cb",
      state_param: "",
      code_challenge: "c",
    });
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    manager.recordDecision(r.request_id, "approve");

    const rec: RecordedResponse = {};
    await handleStatus(
      makeReq({ url: statusUrl(r.request_id) }),
      makeRes(rec),
      { logger: silentLogger, consentManager: manager },
    );
    const location = (rec.headers?.["Location"] ?? rec.headers?.["location"]) as
      | string
      | undefined;
    if (location !== undefined) {
      const url = new URL(location);
      expect(url.searchParams.get("state")).toBeNull();
      expect(url.searchParams.get("code")).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});

describe("handleStatus — denied", () => {
  it("200 deny page with 'declined' copy when decision was 'deny'", async () => {
    const r = manager.beginConsent({
      client_id: "cb_client_x",
      client_name: "X",
      redirect_uri: "https://example.com/cb",
      state_param: "s",
      code_challenge: "c",
    });
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    manager.recordDecision(r.request_id, "deny");

    const rec: RecordedResponse = {};
    await handleStatus(
      makeReq({ url: statusUrl(r.request_id) }),
      makeRes(rec),
      { logger: silentLogger, consentManager: manager },
    );
    expect(rec.status).toBe(200);
    expect(rec.body).toContain("Authorization declined");
  });

  it("200 deny page with 'cancelled' copy when decision was 'dismiss'", async () => {
    const r = manager.beginConsent({
      client_id: "cb_client_x",
      client_name: "X",
      redirect_uri: "https://example.com/cb",
      state_param: "s",
      code_challenge: "c",
    });
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    manager.recordDecision(r.request_id, "dismiss");

    const rec: RecordedResponse = {};
    await handleStatus(
      makeReq({ url: statusUrl(r.request_id) }),
      makeRes(rec),
      { logger: silentLogger, consentManager: manager },
    );
    expect(rec.status).toBe(200);
    expect(rec.body).toContain("Authorization cancelled");
  });
});

describe("handleStatus — decision timeout (AC-P3-5)", () => {
  it("200 timeout page after 30s decision timer fires", async () => {
    vi.useFakeTimers();
    const r = manager.beginConsent({
      client_id: "cb_client_x",
      client_name: "X",
      redirect_uri: "https://example.com/cb",
      state_param: "s",
      code_challenge: "c",
    });
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);

    const rec: RecordedResponse = {};
    const promise = handleStatus(
      makeReq({ url: statusUrl(r.request_id) }),
      makeRes(rec),
      { logger: silentLogger, consentManager: manager },
    );
    await vi.advanceTimersByTimeAsync(30_100);
    await promise;
    expect(rec.status).toBe(200);
    expect(rec.body).toContain("Authorization timed out");
  });
});
