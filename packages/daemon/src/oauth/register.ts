// T-P3-001: OAuth Dynamic Client Registration endpoint (RFC 7591).
// Mounts at `/register`. Unauthenticated by design — DCR is bootstrap
// registration, no credential exists yet to present.
//
// Decision c (T-P3-001 dispatch): liberal-accept on request validation.
// Strict on `redirect_uris` (required, non-empty array of URI-shaped
// strings); accept-and-default on `client_name`; pass through all other
// RFC 7591 optional metadata without 400-ing. Rationale: claude.ai's DCR
// client shape is unmapped (C-21); over-strict rejection is the most
// likely AC-P3-12 live-smoke failure.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  OAuthDcrRequestSchema,
  type OAuthDcrResponse,
} from "@claude-bridge/shared";
import type { Logger } from "../log/logger.js";
import type { ClientsStore } from "./clients-store.js";

const DEFAULT_CLIENT_NAME = "unnamed-client";
const MAX_BODY_BYTES = 64 * 1024; // 64 KB — generous for RFC 7591 metadata

export interface RegisterHandlerDeps {
  logger: Logger;
  clientsStore: ClientsStore;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text, "utf8"),
  });
  res.end(text);
}

function sendDcrError(
  res: ServerResponse,
  error: string,
  description: string,
): void {
  // RFC 7591 §3.2.2 error shape.
  sendJson(res, 400, {
    error,
    error_description: description,
  });
}

export async function handleRegister(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RegisterHandlerDeps,
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  let bodyText: string;
  try {
    bodyText = await readBody(req);
  } catch (err) {
    deps.logger.warn("oauth register: body read failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendDcrError(res, "invalid_request", "failed to read request body");
    return;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(bodyText);
  } catch {
    sendDcrError(res, "invalid_request", "request body is not valid JSON");
    return;
  }

  // Liberal-accept validation per Decision c. Strict on the two fields we
  // consume; passthrough on everything else.
  const result = OAuthDcrRequestSchema.safeParse(parsedJson);
  if (!result.success) {
    // RFC 7591 §3.2.2: `invalid_redirect_uri` for redirect_uris problems,
    // `invalid_client_metadata` for other metadata. We narrow on the first
    // issue's path to pick the closer-fitting error code.
    const firstPath = result.error.issues[0]?.path[0];
    const code =
      firstPath === "redirect_uris"
        ? "invalid_redirect_uri"
        : "invalid_client_metadata";
    sendDcrError(
      res,
      code,
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
    return;
  }

  const { redirect_uris } = result.data;
  const client_name = result.data.client_name ?? DEFAULT_CLIENT_NAME;

  const { record, client_secret_plaintext } = await deps.clientsStore.addClient(
    {
      client_name,
      redirect_uris,
    },
  );

  // INVARIANT (security): the plaintext secret leaves this code ONLY in
  // the response body below. It is NEVER logged. The store persisted the
  // bcryptjs hash only.
  deps.logger.info("oauth client registered", {
    client_id: record.client_id,
    client_name: record.client_name,
    redirect_uris_count: redirect_uris.length,
  });

  const response: OAuthDcrResponse = {
    client_id: record.client_id,
    client_secret: client_secret_plaintext,
    client_id_issued_at: Math.floor(
      new Date(record.created_at).getTime() / 1000,
    ),
    client_name: record.client_name,
    redirect_uris: record.redirect_uris,
    // Echo the daemon's supported capabilities (Decision d) so clients
    // can introspect without a second metadata round-trip.
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  };

  sendJson(res, 201, response);
}
