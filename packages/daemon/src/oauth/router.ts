// T-P3-001 + T-P3-002: OAuth router. Composes the unauthenticated
// endpoint handlers into a single function that McpServer's HTTP
// listener calls before its Bearer auth check.
//
// Returns true when the request matched one of the OAuth routes (caller
// short-circuits); false when the URL didn't match (caller continues to
// MCP routing).
//
// Matching is exact (`===`) on the URL path component only — anchored
// from start to end of path; query strings are stripped before compare.
// Negative tests cover non-OAuth paths to ensure they fall through.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "../log/logger.js";
import type { ClientsStore } from "./clients-store.js";
import type { ConsentManager } from "./consent.js";
import { handleAuthorize } from "./authorize.js";
import { handleMetadata } from "./metadata.js";
import { handleProtectedResourceMetadata } from "./protected-resource.js";
import { handleRegister } from "./register.js";
import { handleStatus } from "./status.js";
import { handleToken } from "./token-endpoint.js";
import type { TokenStore } from "./token-store.js";

const METADATA_PATH = "/.well-known/oauth-authorization-server";
// CB-OAUTH-DISCOVERY-FIX: RFC 9728 protected-resource metadata — the FIRST
// discovery step claude.ai fetches; MUST be public (was unimplemented →
// fell through to the Bearer gate → 401 → discovery aborted before /register).
const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
const REGISTER_PATH = "/register";
// T-P3-002: consent flow endpoints.
const AUTHORIZE_PATH = "/authorize";
const AUTHORIZE_STATUS_PATH = "/authorize/status";
// T-P3-004a: token endpoint.
const TOKEN_PATH = "/token";

export interface OAuthRouterDeps {
  logger: Logger;
  clientsStore: ClientsStore;
  // T-P3-002: optional. When omitted, /authorize + /authorize/status
  // route to false (MCP fall-through) so legacy callers don't suddenly
  // see new endpoints. Production wiring passes a real manager.
  consentManager?: ConsentManager;
  // T-P3-004a: optional. When omitted, /token falls through. Production
  // wiring passes a real store; /token needs both consentManager (redeem)
  // and tokenStore (mint) to function.
  tokenStore?: TokenStore;
  // CB-DAEMON-LIFECYCLE-FIX (c2): threaded into /authorize so the offline
  // page can distinguish "connected but unregistered" from "no extension".
  countConnectedExtensions?: () => number;
}

function pathOf(req: IncomingMessage): string {
  // URL may include `?query`; we route on path only.
  const url = req.url ?? "";
  const qIndex = url.indexOf("?");
  return qIndex === -1 ? url : url.slice(0, qIndex);
}

export function makeOAuthRouter(
  deps: OAuthRouterDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const path = pathOf(req);
    if (path === METADATA_PATH) {
      handleMetadata(req, res, { logger: deps.logger });
      return true;
    }
    if (path === PROTECTED_RESOURCE_PATH) {
      handleProtectedResourceMetadata(req, res, { logger: deps.logger });
      return true;
    }
    if (path === REGISTER_PATH) {
      await handleRegister(req, res, {
        logger: deps.logger,
        clientsStore: deps.clientsStore,
      });
      return true;
    }
    if (path === AUTHORIZE_PATH && deps.consentManager !== undefined) {
      await handleAuthorize(req, res, {
        logger: deps.logger,
        clientsStore: deps.clientsStore,
        consentManager: deps.consentManager,
        countConnectedExtensions: deps.countConnectedExtensions,
      });
      return true;
    }
    if (
      path === AUTHORIZE_STATUS_PATH &&
      deps.consentManager !== undefined
    ) {
      await handleStatus(req, res, {
        logger: deps.logger,
        consentManager: deps.consentManager,
      });
      return true;
    }
    if (
      path === TOKEN_PATH &&
      deps.consentManager !== undefined &&
      deps.tokenStore !== undefined
    ) {
      await handleToken(req, res, {
        logger: deps.logger,
        clientsStore: deps.clientsStore,
        consentManager: deps.consentManager,
        tokenStore: deps.tokenStore,
      });
      return true;
    }
    return false;
  };
}
