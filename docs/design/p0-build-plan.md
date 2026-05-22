# P0 Build Plan

**Status:** Ready for implementation
**Last updated:** 2026-05-01
**Implements:** `01-p0-bus.md`
**Conventions:** `00-overview.md`

This is a **build plan**, not a design doc. The design — what gets built and why — lives in `01-p0-bus.md`. This doc translates that design into ordered, concrete tasks: file paths, exports, function shapes, dependencies, and verification steps. The acceptance criteria in `01-p0-bus.md` (numbered 1–10) are the contract this build plan must satisfy.

How to drive the build is up to you. Options: code it manually with `01-p0-bus.md` open; use Claude Code in VS Code with this doc + `01-p0-bus.md` as context; delegate task-by-task. The plan is structured to be executed top-to-bottom either way.

## Prerequisites

- Node 20.10+ installed
- npm 10+ (workspaces support)
- `cloudflared` binary on PATH (`brew install cloudflared` / `winget install Cloudflare.cloudflared` / [direct download](https://github.com/cloudflare/cloudflared/releases))
- A Claude.ai project to test the connector against (existing project is fine)

## Task order

### 1. Repository scaffolding

**1.1 — Initialize workspace root**

Files:
```
package.json          # npm workspaces declaration
tsconfig.base.json    # shared TS config
.gitignore
.editorconfig
.nvmrc                # node 20
README.md
```

`package.json` declares workspaces:
```json
{
  "name": "claude-bridge",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "lint": "npm run lint --workspaces --if-present"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.4.0",
    "@types/node": "^20.11.0"
  }
}
```

`tsconfig.base.json` extends to per-package configs. ES2022 target, NodeNext modules, strict mode on, `noUncheckedIndexedAccess: true`.

`.gitignore` covers `node_modules/`, `dist/`, `*.tsbuildinfo`, `.DS_Store`, and `.claude-bridge/` (in case anyone runs the daemon from the repo root).

Verify: `npm install` succeeds at root.

**1.2 — Package skeletons**

Create empty package directories with their own `package.json` and `tsconfig.json`:
```
packages/shared/
packages/daemon/
packages/cli/
```

Each `tsconfig.json` extends `../../tsconfig.base.json`, sets `outDir: dist`, `composite: true`, `references` as needed.

Build order (enforced via TS project references): `shared` → `daemon` → `cli`.

Verify: `npm run build` from root succeeds with no source files yet (empty packages compile clean).

### 2. packages/shared

This package is contracts only. No runtime logic, no I/O. Other packages import types and Zod schemas from here.

**2.1 — Install deps**

```
cd packages/shared
npm install zod
```

**2.2 — Files**

```
packages/shared/src/
  config.ts           # Config Zod schema + inferred type
  audit.ts            # AuditEntry types
  ipc.ts              # CLI ↔ daemon IPC message types
  tools.ts            # MCP tool input/output types (ping for P0)
  index.ts            # re-exports
```

**`config.ts`** — full schema matching `01-p0-bus.md` "Config file" section:
```typescript
export const ConfigSchema = z.object({
  version: z.literal(1),
  daemon: z.object({
    bind_host: z.string().default("127.0.0.1"),
    bind_port: z.number().int().min(1).max(65535).default(7423),
    ipc_socket: z.string()                    // expanded path, no ~
  }),
  auth: z.object({
    token: z.string().regex(/^cb_live_[A-Z2-7]{32}$/)
  }),
  tunnel: z.object({
    provider: z.enum(["cloudflared", "ngrok"]).default("cloudflared"),
    binary: z.string().default("cloudflared"),
    args_extra: z.array(z.string()).default([])
  }),
  audit: z.object({
    path: z.string(),
    retention_days: z.number().int().min(1).default(30)
  }),
  log: z.object({
    path: z.string(),
    level: z.enum(["debug", "info", "warn", "error"]).default("info")
  })
});
export type Config = z.infer<typeof ConfigSchema>;
```

**`audit.ts`**:
```typescript
export interface AuditEntry {
  ts: string;             // ISO 8601 UTC
  tool: string;
  input_hash: string;     // "sha256:..."
  allowed: boolean;
  reason?: string;        // when allowed=false
  duration_ms: number;
  result_bytes: number;
  request_id: string;
  remote_addr: string;
}
```

**`ipc.ts`** — discriminated union of CLI→daemon and daemon→CLI messages:
```typescript
export type IpcRequest =
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "token_rotate" }
  | { kind: "tunnel_restart" };

export type IpcResponse =
  | { kind: "status_ok"; payload: StatusPayload }
  | { kind: "stop_ok" }
  | { kind: "token_rotate_ok"; new_token: string }
  | { kind: "tunnel_restart_ok"; new_url: string }
  | { kind: "error"; message: string };

export interface StatusPayload {
  daemon_pid: number;
  daemon_uptime_s: number;
  endpoint: string;             // "127.0.0.1:7423"
  tunnel_status: "up" | "degraded" | "down";
  tunnel_url: string | null;
  token_suffix: string;         // last 4 chars only
  audit_path: string;
  audit_size_bytes: number;
  attached_workspaces: number;  // always 0 in P0
}
```

**`tools.ts`** — ping schema:
```typescript
export const PingInputSchema = z.object({
  message: z.string().max(1024).optional()
}).strict();
export type PingInput = z.infer<typeof PingInputSchema>;

export interface PingOutput {
  echo: string | null;
  daemon_version: string;
  uptime_s: number;
  attached_workspaces: number;
  tunnel_status: "up" | "degraded";
  server_time: string;
}
```

**`index.ts`** re-exports everything.

Verify: `npm run build -w packages/shared` succeeds.

### 3. packages/daemon — foundation

**3.1 — Install deps**

```
cd packages/daemon
npm install @modelcontextprotocol/sdk zod
npm install -D @types/node
```

**3.2 — Logger**

```
packages/daemon/src/log/logger.ts
```

Minimal pino-style logger: levels (debug/info/warn/error), JSON line output to file with stdout mirror. Don't pull in pino — a 60-line implementation is fine and avoids a dep. Rotate policy: same file forever (manual rotation via `tail-log` + log-rotate is acceptable for v1).

Exports: `createLogger(path: string, level: LogLevel) → Logger`.

**3.3 — Config layer**

Files:
```
packages/daemon/src/config/paths.ts      # XDG-style path resolution
packages/daemon/src/config/load.ts       # read + validate + permission check
packages/daemon/src/config/init.ts       # first-run generation
packages/daemon/src/config/token.ts      # token generation
```

**`paths.ts`** — resolve `~/.claude-bridge/` on Unix, `%APPDATA%/claude-bridge/` on Windows. Single function `getConfigDir(): string`. Expand `~` in config values relative to home dir.

**`token.ts`**:
```typescript
import { randomBytes } from "node:crypto";

export function generateToken(): string {
  // base32 without padding, 32 chars (160 bits of entropy)
  const bytes = randomBytes(20);
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let out = "";
  for (let i = 0; i < 20; i++) out += ALPHABET[bytes[i]! % 32];
  // Better: real base32 encoding. Use a tiny implementation or `base32-encode`.
  return `cb_live_${out}`;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
```

Use proper base32 (RFC 4648) — pull in `base32-encode` or write 30 lines. Don't ship the modulo bias version.

**`load.ts`**:
```typescript
export async function loadConfig(path: string): Promise<Config> {
  // 1. fs.stat — check exists
  // 2. on Unix, check mode & 0o077 === 0; throw if looser than 0600
  // 3. read JSON, parse, ConfigSchema.parse
  // 4. expand ~ in path fields
  // 5. return
}
```

Throw typed errors: `ConfigNotFoundError`, `ConfigPermissionError`, `ConfigValidationError`.

**`init.ts`**:
```typescript
export async function initConfig(path: string): Promise<Config> {
  // 1. mkdir parent with 0700
  // 2. generate token
  // 3. build default Config object with expanded paths
  // 4. write JSON with mode 0600
  // 5. return
}
```

Verify: unit test that round-trips init → load and rejects loose perms (chmod 0644 → throws).

**3.4 — Audit log**

```
packages/daemon/src/audit/log.ts
```

Class `AuditLog`:
```typescript
class AuditLog {
  constructor(path: string, retentionDays: number);
  async append(entry: AuditEntry): Promise<void>;
  async rotate(): Promise<void>;       // if past midnight, rename current to audit-YYYY-MM-DD.jsonl
  async pruneOld(): Promise<void>;     // delete files older than retentionDays
  startMidnightTimer(): void;          // schedules rotate+prune at next midnight UTC
  stop(): void;
}
```

Append serialization: maintain a single fs handle, queue writes (Promise chain) to avoid interleaving. JSON.stringify + `\n`.

Hash helper for `input_hash`:
```typescript
export function hashInput(input: unknown): string {
  const canon = JSON.stringify(input, Object.keys(input as object).sort());
  return "sha256:" + createHash("sha256").update(canon).digest("hex");
}
```

Verify: unit test for append, rotate at synthetic midnight, prune of files dated 31 days ago.

**3.5 — IPC server**

```
packages/daemon/src/ipc/server.ts
packages/daemon/src/ipc/protocol.ts
```

**`protocol.ts`** — newline-delimited JSON. Each message a single line. Length-prefix not needed at this scale.

**`server.ts`** — Unix domain socket on Linux/Mac, named pipe on Windows. Node's `net.createServer` works for both (`net.connect("\\\\.\\pipe\\claude-bridge")` on Windows).

```typescript
class IpcServer {
  constructor(path: string, handlers: IpcHandlers);
  async start(): Promise<void>;
  async stop(): Promise<void>;
}

interface IpcHandlers {
  status(): Promise<StatusPayload>;
  stop(): Promise<void>;
  tokenRotate(): Promise<{ new_token: string }>;
  tunnelRestart(): Promise<{ new_url: string }>;
}
```

Socket file mode `0600` on Unix. Clean up stale socket on start (unlink if exists, no other listener).

Verify: spin up server, connect with `net.connect`, send `{"kind":"status"}`, get `status_ok` back.

### 4. packages/daemon — MCP server

**4.1 — HTTP transport**

The official MCP SDK provides streamable HTTP transport. Use it.

Files:
```
packages/daemon/src/mcp/server.ts
packages/daemon/src/mcp/auth.ts
packages/daemon/src/mcp/dispatch.ts
packages/daemon/src/mcp/tools/ping.ts
```

**`auth.ts`** — middleware that pulls `Authorization: Bearer <token>`, constant-time compares, returns 401 with empty body and audit-logged rejection on mismatch.

**`server.ts`** — wraps the MCP SDK's `Server` instance. Binds HTTP listener to `config.daemon.bind_host:port`. Mounts auth before MCP transport. Exposes:
```typescript
class McpServer {
  constructor(opts: {
    config: Config;
    audit: AuditLog;
    logger: Logger;
    state: DaemonState;        // for ping to read uptime_s, attached_workspaces, etc.
    tools: ToolRegistry;
  });
  async start(): Promise<void>;
  async stop(): Promise<void>;
}
```

**`dispatch.ts`** — tool registry pattern. P0 has one entry but the shape must support N for P1+:
```typescript
interface ToolDef<I, O> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  handler: (input: I, ctx: ToolContext) => Promise<O>;
}

class ToolRegistry {
  register<I, O>(def: ToolDef<I, O>): void;
  list(): McpToolDescriptor[];                       // for MCP tools/list
  invoke(name: string, rawInput: unknown, ctx: ToolContext): Promise<unknown>;
}

interface ToolContext {
  request_id: string;
  audit: AuditLog;
  logger: Logger;
  state: DaemonState;
}
```

Dispatch flow: validate input via Zod → call handler → measure duration → write audit entry with `result_bytes = JSON.stringify(output).length` → return.

**`tools/ping.ts`**:
```typescript
export const pingTool: ToolDef<PingInput, PingOutput> = {
  name: "ping",
  description: "Roundtrip test. Returns daemon liveness info.",
  inputSchema: PingInputSchema,
  async handler(input, ctx) {
    return {
      echo: input.message ?? null,
      daemon_version: ctx.state.version,
      uptime_s: Math.floor((Date.now() - ctx.state.startedAt) / 1000),
      attached_workspaces: 0,
      tunnel_status: ctx.state.tunnelStatus === "down" ? "degraded" : ctx.state.tunnelStatus,
      server_time: new Date().toISOString()
    };
  }
};
```

Verify: integration test using `fetch` against the running server with a valid token. Expect 200 + correct shape. Then with a bad token → 401 + audit entry with `allowed: false`.

### 5. packages/daemon — tunnel manager

```
packages/daemon/src/tunnel/cloudflared.ts
packages/daemon/src/tunnel/manager.ts
```

**`cloudflared.ts`**:
```typescript
class CloudflaredProcess extends EventEmitter {
  constructor(opts: { binary: string; localUrl: string; argsExtra: string[] });
  start(): void;
  stop(): Promise<void>;
  // events: "url" (string), "exit" (code), "error" (Error), "log" (line)
}
```

Spawn `cloudflared tunnel --url ${localUrl} ${...argsExtra}`. Parse stderr/stdout line-by-line; cloudflared writes the URL to stderr typically. Regex: `/https:\/\/[a-z0-9-]+\.trycloudflare\.com/`. Emit `url` event on first match.

**`manager.ts`** — restart policy, degraded state:
```typescript
class TunnelManager extends EventEmitter {
  constructor(opts: { config: Config; logger: Logger });
  async start(): Promise<void>;
  async stop(): Promise<void>;
  async restart(): Promise<string>;       // returns new URL or throws
  getStatus(): "up" | "degraded" | "down";
  getUrl(): string | null;
  // events: "url_change" (string), "status_change" (status)
}
```

Restart-on-exit unless `stop()` was called. Track restarts in 5-minute sliding window; after 5, set status to `degraded` and stop auto-respawn until `restart()` called manually.

Verify: kill cloudflared with `kill <pid>`, observe respawn within 30s and new URL emitted. Manual test, not unit testable cleanly.

### 6. packages/daemon — main entry

```
packages/daemon/src/state.ts             # DaemonState type
packages/daemon/src/main.ts              # entry point
packages/daemon/src/pidfile.ts           # PID file management
```

**`pidfile.ts`** — write `process.pid` to `${configDir}/daemon.pid` on start, delete on shutdown. On `start`, if file exists: read PID, send signal 0, if process exists refuse to start; if not, clear stale file.

**`state.ts`**:
```typescript
export interface DaemonState {
  version: string;                  // from package.json
  startedAt: number;                // Date.now()
  config: Config;
  tunnelStatus: "up" | "degraded" | "down";
  tunnelUrl: string | null;
}
```

**`main.ts`** — wires everything:
```typescript
async function main() {
  // 1. resolve config dir, load or init config
  // 2. initialize logger
  // 3. write PID file
  // 4. create AuditLog, start midnight timer
  // 5. create DaemonState
  // 6. create ToolRegistry, register pingTool
  // 7. create McpServer, start it
  // 8. create TunnelManager, start it; subscribe to url_change → update state
  // 9. create IpcServer with handlers that read/mutate state and the above
  // 10. start IpcServer
  // 11. emit "ready" line to stdout for the CLI to detect
  // 12. signal handlers: SIGTERM → graceful shutdown (reverse order, 10s budget)
}
```

Token rotation handler: generate new token, persist config, swap in McpServer's auth state, return new token.

Verify: `node packages/daemon/dist/main.js` from a shell starts the daemon, prints `ready`, and stays up.

### 7. packages/cli

**7.1 — Install deps**

```
cd packages/cli
npm install commander
```

**7.2 — Files**

```
packages/cli/src/index.ts                # commander setup, command registration
packages/cli/src/commands/start.ts
packages/cli/src/commands/stop.ts
packages/cli/src/commands/status.ts
packages/cli/src/commands/tail-log.ts
packages/cli/src/commands/token.ts       # rotate subcommand
packages/cli/src/commands/tunnel.ts      # restart subcommand
packages/cli/src/ipc-client.ts           # connects to daemon socket, sends IpcRequest
```

**`ipc-client.ts`**:
```typescript
export async function sendIpc<R extends IpcResponse>(req: IpcRequest): Promise<R> {
  // 1. read config (just for ipc_socket path)
  // 2. net.connect to socket
  // 3. write JSON line + \n
  // 4. read one line response, parse
  // 5. close, return
  // Timeout: 10s. Throw on timeout or error response.
}
```

**`commands/start.ts`** — most complex:
```typescript
export async function start() {
  // 1. resolve config dir
  // 2. if config missing, run initConfig
  // 3. check PID file: if alive, refuse with helpful message
  // 4. spawn daemon as detached child:
  //    spawn("node", [daemonEntrypoint], {
  //      detached: true,
  //      stdio: ["ignore", pipe, pipe]
  //    })
  //    Read child stdout until "ready" line OR 5s timeout.
  //    On "ready", child.unref(), proceed.
  // 5. send IPC status to fetch tunnel URL (may take another second; retry up to 10s)
  // 6. print:
  //      Daemon up on 127.0.0.1:7423
  //      Tunnel: <url>
  //      Token:  <token from config>
  // 7. exit 0
}
```

`stop`, `status`, `token rotate`, `tunnel restart` — thin wrappers over `sendIpc`.

`tail-log` — read `config.log.path`, optionally `-f` follow with `tail`-style polling or a watcher. Doesn't require IPC.

**7.3 — Bin entry**

`packages/cli/package.json` declares:
```json
{
  "bin": {
    "claude-bridge": "./dist/index.js"
  }
}
```

Shebang `#!/usr/bin/env node` at top of `dist/index.js` (preserve via tsup or post-build script).

`npm link` from `packages/cli/` makes `claude-bridge` available globally during development.

Verify: full lifecycle — `claude-bridge start`, `claude-bridge status`, `claude-bridge stop` all succeed in sequence on a clean machine.

### 8. Acceptance test

```
scripts/acceptance-p0.sh
```

Bash script that walks through criteria 1–10 from `01-p0-bus.md`. Each step prints `PASS` or `FAIL`. Designed for manual run with one prerequisite: a Claude.ai project ready to receive the URL/token, with a human present to drive criterion 3 (calling `ping` from the project chat).

Steps:

```bash
#!/usr/bin/env bash
set -uo pipefail

step() { echo "=== $* ==="; }
pass() { echo "  PASS"; }
fail() { echo "  FAIL: $*"; exit 1; }

# Pre: clean state
rm -rf ~/.claude-bridge

step "1. claude-bridge start within 10s"
START=$(date +%s)
OUTPUT=$(claude-bridge start)
ELAPSED=$(( $(date +%s) - START ))
[ $ELAPSED -lt 10 ] || fail "took ${ELAPSED}s"
echo "$OUTPUT" | grep -q "Tunnel: https://" || fail "no tunnel URL"
echo "$OUTPUT" | grep -q "Token:  cb_live_" || fail "no token"
TUNNEL_URL=$(echo "$OUTPUT" | grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com')
TOKEN=$(echo "$OUTPUT" | grep -oP 'cb_live_[A-Z2-7]{32}')
pass

step "2. status reports up"
claude-bridge status | grep -q "Daemon:    up" || fail
claude-bridge status | grep -q "Tunnel:    up" || fail
pass

step "3. ping from Claude.ai project"
echo "  MANUAL: configure ${TUNNEL_URL} + ${TOKEN} in your Claude.ai project"
echo "  MANUAL: ask project-Claude to call ping(message='hello')"
echo "  MANUAL: confirm response contains echo='hello'"
read -p "  press enter when verified > "
pass

step "4. wrong token returns 401"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer cb_live_WRONGWRONGWRONGWRONGWRONGWRONGWR" \
  -X POST "${TUNNEL_URL}/mcp" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}')
[ "$HTTP" = "401" ] || fail "got $HTTP"
grep -q '"allowed":false' ~/.claude-bridge/audit.jsonl || fail "no audit entry"
pass

step "5. successful ping audit entry"
grep -q '"tool":"ping"' ~/.claude-bridge/audit.jsonl || fail
grep -q '"allowed":true' ~/.claude-bridge/audit.jsonl || fail
pass

step "6. cloudflared kill + respawn"
CFPID=$(pgrep -f "cloudflared tunnel --url" | head -1)
kill "$CFPID"
sleep 35
NEW_URL=$(claude-bridge status | grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com')
[ "$NEW_URL" != "$TUNNEL_URL" ] && [ -n "$NEW_URL" ] || fail "no new URL"
pass

step "7. clean stop"
claude-bridge stop
[ ! -f ~/.claude-bridge/daemon.pid ] || fail "PID file remains"
pass

step "8. token rotate"
claude-bridge start > /dev/null
NEW_TOKEN=$(claude-bridge token rotate | grep -oP 'cb_live_[A-Z2-7]{32}')
HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -X POST "$(claude-bridge status | grep -oP 'https://[^ ]+')/mcp" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}')
[ "$HTTP" = "401" ] || fail "old token still valid"
pass

step "9. loose perms refused"
claude-bridge stop
chmod 0644 ~/.claude-bridge/config.json
claude-bridge start 2>&1 | grep -qi "permission" || fail "started with loose perms"
chmod 0600 ~/.claude-bridge/config.json
pass

step "10. audit log rotation"
echo "  MANUAL or fast-forward clock: verify audit-YYYY-MM-DD.jsonl appears at midnight UTC"
read -p "  press enter to acknowledge > "
pass

echo
echo "ALL P0 ACCEPTANCE CRITERIA PASSED"
```

Step 10's automation needs a clock fake or a 24-hour wait. Acceptable for v1 to verify manually once and consider it covered.

## Definition of done

- [ ] All 10 acceptance criteria pass via `scripts/acceptance-p0.sh`
- [ ] `npm run build` clean from root
- [ ] `npm run test` passes (unit tests for config, audit, token, IPC)
- [ ] `npm run lint` clean
- [ ] No `TODO` or `FIXME` in `packages/daemon/src/mcp/` or `packages/cli/src/commands/`
- [ ] README at repo root with quick-start (install cloudflared, npm install, npm link, claude-bridge start)
- [ ] Runbook at `docs/runbook.md` covering install, start, stop, rotate, tunnel-restart, status, troubleshooting (port collision, stale PID, cloudflared not on PATH)
- [ ] One Claude.ai project successfully exercises `ping` end-to-end
- [ ] P1 design doc (`docs/design/02-p1-delegation.md`) started — kicks off the next gate

## Estimated effort

Rough sizing for execution (focused work, not calendar time):

| Section | Hours |
|---|---|
| 1. Repo scaffolding | 1 |
| 2. packages/shared | 2 |
| 3. Daemon foundation (config, audit, IPC) | 6 |
| 4. MCP server + ping | 5 |
| 5. Tunnel manager | 4 |
| 6. Daemon main wiring | 3 |
| 7. CLI | 5 |
| 8. Acceptance test + runbook + README | 3 |
| **Total** | **~29 hours** |

At your evening-work pattern, plan for 3–5 weeks calendar to gate.

## Out of scope (still)

Same as `01-p0-bus.md` "Out of scope" section. No workspaces, no Claude Code, no extension, no auto-attach, no Tier-2 tools, no autostart, no named tunnels. Resist scope creep — every shortcut becomes a P1 problem.
