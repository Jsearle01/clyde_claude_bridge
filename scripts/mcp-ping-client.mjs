// Throwaway helper for scripts/acceptance-p0.ps1. Drives the daemon over MCP
// using the official SDK client and prints the tools/call result as JSON.
//
// Usage:
//   node scripts/mcp-ping-client.mjs <tunnelUrl> <token>          (success path)
//   node scripts/mcp-ping-client.mjs <tunnelUrl> <token> --expect-401  (rejection path)
//
// In --expect-401 mode the script exits 0 when the daemon rejects the request
// (any 4xx / connect-time auth failure) and non-zero if the request is somehow
// accepted. The PowerShell acceptance harness does the actual audit-log
// assertions; this helper is only the transport.

import process from "node:process";
import dns from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Force Cloudflare + Google public resolvers via c-ares. Some host networks
// (corporate DNS, ISP filtering, router NXDOMAIN cache) can't resolve
// newly-issued trycloudflare.com subdomains for several minutes. Public DNS
// sees them immediately.
//
// dns.setServers() only affects dns.resolve*() (c-ares); dns.lookup() uses
// the OS getaddrinfo and ignores it. fetch (via undici) uses dns.lookup by
// default — so we hand it a custom lookup that calls dns.resolve4 instead.
dns.setServers(["1.1.1.1", "8.8.8.8"]);
setGlobalDispatcher(
  new Agent({
    connect: {
      // undici's net.connect lookup with `all: true` expects the callback to
      // receive an array of { address, family } records. Single-record shape
      // is for when `all` is false. Match dns.lookup's polymorphic contract.
      lookup(hostname, options, callback) {
        dns.resolve4(hostname, (err, addrs) => {
          if (err) {
            callback(err);
            return;
          }
          if (options.all) {
            callback(
              null,
              addrs.map((address) => ({ address, family: 4 })),
            );
          } else {
            callback(null, addrs[0], 4);
          }
        });
      },
    },
  }),
);

const args = process.argv.slice(2);
if (args.length < 2) {
  process.stderr.write(
    "Usage: node mcp-ping-client.mjs <tunnelUrl> <token> [--expect-401]\n",
  );
  process.exit(2);
}

const [tunnelUrl, token] = args;
const expect401 = args.includes("--expect-401");

const mcpUrl = new URL("/mcp", tunnelUrl);

const transport = new StreamableHTTPClientTransport(mcpUrl, {
  requestInit: {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  },
});

const client = new Client(
  { name: "claude-bridge-acceptance", version: "0.1.0" },
  { capabilities: {} },
);

async function runHappyPath() {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  if (!names.includes("ping")) {
    process.stderr.write(
      `expected 'ping' in tools/list, got: ${names.join(", ")}\n`,
    );
    await client.close();
    process.exit(3);
  }
  const result = await client.callTool({
    name: "ping",
    arguments: { message: "hello" },
  });
  process.stdout.write(JSON.stringify(result) + "\n");
  await client.close();
}

async function runExpect401() {
  try {
    await client.connect(transport);
  } catch (err) {
    // Any failure here counts as a rejection — auth errors typically manifest
    // as HTTP 401 during initialize / first POST.
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`rejected (as expected): ${msg}\n`);
    process.exit(0);
  }
  // If connect succeeded, try listTools — the daemon may accept connect but
  // reject the first authenticated request.
  try {
    await client.listTools();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`rejected on listTools: ${msg}\n`);
    await client.close();
    process.exit(0);
  }
  await client.close();
  process.stderr.write("expected 401-equivalent rejection but request was accepted\n");
  process.exit(4);
}

if (expect401) {
  await runExpect401();
} else {
  try {
    await runHappyPath();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`MCP roundtrip failed: ${msg}\n`);
    process.exit(5);
  }
}
