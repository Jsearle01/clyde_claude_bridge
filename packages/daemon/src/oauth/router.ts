// T-P3-001: OAuth bootstrap router. Composes the two unauthenticated
// endpoint handlers (metadata + register) into a single function that
// McpServer's HTTP listener calls before its Bearer auth check.
//
// Returns true when the request matched one of the OAuth routes (caller
// short-circuits); false when the URL didn't match (caller continues to
// MCP routing).

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "../log/logger.js";
import type { ClientsStore } from "./clients-store.js";
import { handleMetadata } from "./metadata.js";
import { handleRegister } from "./register.js";

const METADATA_PATH = "/.well-known/oauth-authorization-server";
const REGISTER_PATH = "/register";

export interface OAuthRouterDeps {
  logger: Logger;
  clientsStore: ClientsStore;
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
    if (path === REGISTER_PATH) {
      await handleRegister(req, res, {
        logger: deps.logger,
        clientsStore: deps.clientsStore,
      });
      return true;
    }
    return false;
  };
}
