// MCP client driver for the P1 acceptance harness. Reusable beyond the
// harness for ad-hoc developer usage via CLI subcommands.
//
// Carries P0's DNS-via-undici-dispatcher workaround (T-0019) — needed when
// the daemon is exposed via a newly-issued *.trycloudflare.com subdomain
// whose name hasn't propagated to the host's local DNS. For localhost
// connections (harness default) the workaround is a no-op.
//
// Usage:
//   node scripts/mcp-delegate-client.mjs delegate --prompt "..." [opts]
//   node scripts/mcp-delegate-client.mjs poll --job-id ID [--wait-ms N]
//   node scripts/mcp-delegate-client.mjs cancel --job-id ID
//   node scripts/mcp-delegate-client.mjs wait --job-id ID [--max-wait-ms N]
//   node scripts/mcp-delegate-client.mjs list-tools
//
// Connection: --url and --token args, or env vars CLAUDE_BRIDGE_URL /
// CLAUDE_BRIDGE_TOKEN.

import process from "node:process";
import dns from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

dns.setServers(["1.1.1.1", "8.8.8.8"]);
setGlobalDispatcher(
  new Agent({
    connect: {
      lookup(hostname, options, callback) {
        // Localhost: skip c-ares; OS resolver knows about 127.0.0.1.
        if (hostname === "localhost" || hostname === "127.0.0.1") {
          if (options.all) {
            callback(null, [{ address: "127.0.0.1", family: 4 }]);
          } else {
            callback(null, "127.0.0.1", 4);
          }
          return;
        }
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

// ---- JS API (importable) ----

export async function connect({ url, token }) {
  const mcpUrl = new URL("/mcp", url);
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
  const client = new Client(
    { name: "claude-bridge-p1-acceptance", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

export async function callTool(client, name, input) {
  try {
    const result = await client.callTool({ name, arguments: input });
    return { result, isError: result.isError === true };
  } catch (err) {
    return {
      result: { errorMessage: err instanceof Error ? err.message : String(err) },
      isError: true,
    };
  }
}

export async function listTools(client) {
  const out = await client.listTools();
  return out.tools;
}

// ---- CLI ----

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function runCli() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  const url = args.url ?? process.env.CLAUDE_BRIDGE_URL;
  const token = args.token ?? process.env.CLAUDE_BRIDGE_TOKEN;

  if (!cmd) {
    process.stderr.write(
      "Usage: mcp-delegate-client <delegate|poll|cancel|wait|list-tools> [opts]\n",
    );
    process.exit(2);
  }
  if (!url || !token) {
    process.stderr.write(
      "Missing --url/--token (or CLAUDE_BRIDGE_URL/CLAUDE_BRIDGE_TOKEN env)\n",
    );
    process.exit(2);
  }

  const client = await connect({ url, token });

  try {
    switch (cmd) {
      case "list-tools": {
        const tools = await listTools(client);
        process.stdout.write(JSON.stringify(tools, null, 2) + "\n");
        break;
      }
      case "delegate": {
        const input = { prompt: args.prompt };
        if (args.workspace) input.workspace = args.workspace;
        if (args.mode) input.mode = args.mode;
        if (args["max-turns"]) input.max_turns = Number(args["max-turns"]);
        if (args["working-dir"]) input.working_directory = args["working-dir"];
        const { result } = await callTool(client, "delegate_to_claude_code", input);
        process.stdout.write(JSON.stringify(result.structuredContent ?? result, null, 2) + "\n");
        break;
      }
      case "poll": {
        const input = { job_id: args["job-id"] };
        if (args["wait-ms"]) input.wait_ms = Number(args["wait-ms"]);
        const { result } = await callTool(client, "poll_delegation", input);
        process.stdout.write(JSON.stringify(result.structuredContent ?? result, null, 2) + "\n");
        break;
      }
      case "cancel": {
        const { result } = await callTool(client, "cancel_delegation", {
          job_id: args["job-id"],
        });
        process.stdout.write(JSON.stringify(result.structuredContent ?? result, null, 2) + "\n");
        break;
      }
      case "wait": {
        const jobId = args["job-id"];
        const maxWait = Number(args["max-wait-ms"] ?? 30000);
        const deadline = Date.now() + maxWait;
        let last;
        while (Date.now() < deadline) {
          const { result } = await callTool(client, "poll_delegation", {
            job_id: jobId,
            wait_ms: Math.min(5000, deadline - Date.now()),
          });
          last = result.structuredContent ?? result;
          if (
            last.status === "complete" ||
            last.status === "failed" ||
            last.status === "cancelled"
          ) {
            break;
          }
        }
        process.stdout.write(JSON.stringify(last, null, 2) + "\n");
        break;
      }
      default:
        process.stderr.write(`Unknown command: ${cmd}\n`);
        process.exit(2);
    }
  } finally {
    await client.close();
  }
}

// Only run CLI when invoked directly.
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("mcp-delegate-client.mjs") ||
    process.argv[1].endsWith("mcp-delegate-client"));
if (isMain) {
  runCli().catch((err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
