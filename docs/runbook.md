# claude-bridge runbook

Operational reference. Pairs with the project [README](../README.md) (what is this, how to install) — this doc covers "I have it running; how do I work with it; what do I do when X breaks."

## Lifecycle

### `claude-bridge start`

Brings up the daemon and tunnel. Pre-flight: cloudflared must be on PATH (or `tunnel.binary` set in config); no existing daemon may be running (PID file checked via signal-0 probe; stale files are tolerated).

```
$ claude-bridge start
Daemon up on 127.0.0.1:7423
Tunnel: https://random-words-here.trycloudflare.com
Token:  cb_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
```

The CLI waits for the daemon to emit `ready\n` (up to 15s; the daemon's own tunnel-startup budget is 15s per cloudflared subprocess), then detaches. The daemon survives the parent shell exiting. First-run init creates `config.json` with a fresh token if none exists.

### `claude-bridge stop`

Graceful shutdown via IPC. Idempotent:

| PID file state | Behavior |
|---|---|
| Absent | `Daemon not running.` (exit 0) |
| Stale (no live process) | `Daemon PID file is stale; removing.` (exit 0) |
| Live + IPC succeeds | `Stopped.` (exit 0) |
| Live + connection error | `Daemon shut down.` (exit 0 — assumes the daemon died between PID-check and IPC) |
| Live + timeout (12s) | Exits 1 with `Daemon did not respond within 12000ms.` |

Reverse-instantiation shutdown sequence (IPC server → MCP server → tunnel → audit log → logger) completes well under the 10s budget in normal cases.

### `claude-bridge status`

Prints either a one-line `Daemon: down` (PID absent or stale) or the formatted block:

```
Daemon:    up (pid 84231, uptime 2h14m)
Endpoint:  127.0.0.1:7423
Tunnel:    up
URL:       https://random-words-here.trycloudflare.com
Token:     cb_live_…AAAA (last 4)
Audit:     ~/.claude-bridge/audit.jsonl (current size: 14 KB)
```

Token suffix only (last 4 chars). To recover the full token: read `~/.claude-bridge/config.json` (or `%APPDATA%\claude-bridge\config.json` on Windows) — `auth.token`. File is mode-0600 on Unix.

### `claude-bridge tail-log`

Streams the daemon log (`log.path` from config) to stdout. Plain dump and exit by default; `-f` / `--follow` tails for new appends until SIGINT.

```bash
claude-bridge tail-log         # dump existing then exit
claude-bridge tail-log -f      # follow
```

Tolerates truncation. Does NOT yet handle rotation (daemon.log doesn't rotate; only audit.jsonl does — see AC-10).

### `claude-bridge token rotate`

Mints a fresh token, persists to config.json (mode-0600 on Unix), invalidates the previous token in memory **immediately**. The next MCP request with the old token returns 401.

```
$ claude-bridge token rotate
Token rotated.
New token: cb_live_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB

Update any MCP clients with the new token. The previous token is no longer valid.
```

UX implication: every connected client must be re-authenticated. Plan rotation windows accordingly.

### `claude-bridge tunnel restart`

Stops the existing cloudflared subprocess and spawns a new one. Used as the manual recovery path from `tunnel_status: degraded` (the automatic sliding-window restart policy gives up after 5 restarts in 5 minutes).

```
$ claude-bridge tunnel restart
Tunnel restarted.
New URL: https://different-words.trycloudflare.com

Update any MCP clients with the new URL.
```

20s CLI timeout (cloudflared startup + buffer). If the daemon's own restart attempt fails (e.g. cloudflared crashed during init), the CLI surfaces the daemon's error message.

### `claude-bridge --version` / `--help`

Standard commander conventions. `-V` / `-h` are aliases. `--help` on a parent command (e.g. `claude-bridge token`) prints subcommand help.

## Configuration

`~/.claude-bridge/config.json` (Unix) or `%APPDATA%\claude-bridge\config.json` (Windows). Generated at first run with sensible defaults; edit manually for non-default behavior.

```json
{
  "version": 1,
  "daemon": {
    "bind_host": "127.0.0.1",
    "bind_port": 7423,
    "ipc_socket": "/home/you/.claude-bridge/daemon.sock"
  },
  "auth": {
    "token": "cb_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  },
  "tunnel": {
    "provider": "cloudflared",
    "binary": "cloudflared",
    "args_extra": []
  },
  "audit": {
    "path": "/home/you/.claude-bridge/audit.jsonl",
    "retention_days": 30
  },
  "log": {
    "path": "/home/you/.claude-bridge/daemon.log",
    "level": "info"
  }
}
```

Field notes:
- `daemon.bind_host` — keep at `127.0.0.1`; the tunnel is the only externally-reachable surface.
- `daemon.bind_port` — change if 7423 collides.
- `daemon.ipc_socket` — Unix domain socket path; on Windows, ignored in favor of the hardcoded named pipe `\\.\pipe\claude-bridge`.
- `auth.token` — must match `^cb_live_[A-Z2-7]{32}$`. Rotate via `claude-bridge token rotate`, never by hand-editing (the in-memory copy in the running daemon won't update).
- `tunnel.binary` — override if cloudflared isn't on PATH (e.g. `"C:\\Program Files (x86)\\cloudflared\\cloudflared.exe"`).
- `tunnel.args_extra` — passed through to cloudflared; reserved for future named-tunnel work.
- `audit.retention_days` — rotated files older than this are pruned at midnight.
- `log.level` — `debug` is verbose; `info` is the default; `warn` and `error` are for production tightening.

**Permissions (Unix only).** The daemon refuses to start if `config.json` permissions are looser than 0600 (CC-3). On Windows the file-mode check is a no-op by design.

## Files and directories

| Path | Purpose |
|---|---|
| `~/.claude-bridge/config.json` | Persistent config + token (mode 0600 on Unix) |
| `~/.claude-bridge/daemon.pid` | Live daemon's PID; removed on clean shutdown |
| `~/.claude-bridge/daemon.log` | Application log (current day; no rotation yet) |
| `~/.claude-bridge/audit.jsonl` | Audit log, current day's entries |
| `~/.claude-bridge/audit-YYYY-MM-DD.jsonl` | Rotated audit log for a past UTC day |
| `~/.claude-bridge/daemon.sock` | IPC socket (Unix only) |

On Windows substitute `%APPDATA%\claude-bridge\` and `\\.\pipe\claude-bridge` for the IPC endpoint.

## Troubleshooting

### `cloudflared not found on PATH`

`claude-bridge start` exits 1. Install cloudflared (see README Prerequisites) or set `tunnel.binary` in config to the full path.

Verify: `cloudflared --version`.

### Daemon won't start (PID file shows alive)

`claude-bridge start` reports `Daemon already running (pid <X>)`. Run `claude-bridge status` — if it reports `up`, a daemon really is alive; stop it via `claude-bridge stop`. If status reports `down` but the file remains, the PID file is stale; the stale-detection in `start` should clear it automatically. If not, remove `daemon.pid` manually after confirming no `node` process owns that PID.

### Port collision (7423 in use)

Edit `daemon.bind_port` in config.json to a free port; restart.

### MCP client reports `fetch failed` / DNS error

Newly-issued `*.trycloudflare.com` subdomains can take 1-2 minutes to propagate through some DNS chains (corporate resolvers, ISPs with NXDOMAIN caching, certain home routers). Symptoms:

- Public DNS (`nslookup <url> 1.1.1.1`) resolves immediately
- Local resolver (`nslookup <url>`) returns `Non-existent domain`

Workarounds:
1. Wait 1-2 minutes and retry
2. Test from a host with public DNS configured
3. Use `scripts/mcp-ping-client.mjs` — it forces Cloudflare/Google DNS via undici's custom dispatcher (T-0019 workaround)

This is a network-environment issue, not a daemon bug.

### Windows console window flashes on `claude-bridge start`

Should not happen — the daemon spawn sets `windowsHide: true` (T-0019.5). If a console window still appears, file an issue with the Node version and Windows build.

### Detached daemon hangs the parent shell on Windows

When launching `claude-bridge start` from a PowerShell script with redirected stdout (`Start-Process -RedirectStandardOutput`, or `cmd /c ... > file`), the redirect file handle inherits to the detached daemon and pins the parent until the daemon exits. This is the **Windows file-handle inheritance trap** codified in [conventions.md CC-2](conventions.md) (T-0019.5).

Workaround for scripted invocation: redirect to `NUL` and rely on `claude-bridge status` polling to detect ready:

```powershell
Start-Process -FilePath "cmd.exe" `
    -ArgumentList @("/c", "claude-bridge.cmd start > NUL 2>&1") `
    -NoNewWindow
# poll: claude-bridge status until "Daemon: up"
```

See `scripts/acceptance-p0.ps1`'s `Start-DaemonAndWait` helper for the canonical implementation.

### Stale audit/log handles after `claude-bridge stop`

Shouldn't happen — the daemon's idempotent close discipline (CC-1) closes both handles before exit. If `tail-log -f` keeps a daemon.log open across a stop+restart, restart the tail.

## Connecting an MCP client (in depth)

### MCP Inspector (recommended for P0)

```bash
npx @modelcontextprotocol/inspector
```

Open the Inspector at the printed local URL. Configure:
- Transport: **Streamable HTTP**
- URL: `<tunnel-url>/mcp` (note the `/mcp` path suffix)
- Header: `Authorization: Bearer <token>` (full token, not the suffix)

`Connect` → `tools/list` → `ping` → call with `{"message": "hello"}` → response includes echo, daemon version, uptime, attached_workspaces:0, tunnel_status, server_time.

### Claude.ai connector UI

**Not currently usable for static Bearer tokens.** The Claude.ai project-settings connector UI exposes only OAuth client_id / client_secret fields; there is no Bearer header field. This is the SMOKE-2 finding from 2026-05-22 smoke testing.

P1+ design decision space:
- Implement OAuth in the daemon (custom IdP)
- Document the alternative-client workaround indefinitely
- Both

For now: use MCP Inspector, Claude Code, or Claude Desktop instead.

### Claude Code

```bash
claude mcp add --transport http <tunnel-url>/mcp --header "Authorization: Bearer <token>"
```

Verify exact flag syntax against the current Claude Code documentation; the SDK transport surface evolves.

### Claude Desktop

Edit Claude Desktop's MCP config (`%APPDATA%\Claude\claude_desktop_config.json` on Windows; `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS) and add an entry:

```json
{
  "mcpServers": {
    "claude-bridge": {
      "type": "http",
      "url": "https://random-words-here.trycloudflare.com/mcp",
      "headers": {
        "Authorization": "Bearer cb_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      }
    }
  }
}
```

Restart Claude Desktop. The `ping` tool should appear in the tool list.

## Verifying acceptance criteria

### AC-9 — daemon refuses loose `config.json` permissions (Unix only)

Implementation is in `loadConfig`; behavior is no-op on Windows (CC-3). Unix procedure:

```bash
claude-bridge stop
chmod 0644 ~/.claude-bridge/config.json
claude-bridge start
# Expected: exits 1 with a permission-error message
chmod 0600 ~/.claude-bridge/config.json
claude-bridge start
# Expected: starts normally
```

Unit-tested at T-0006; live Unix verification still pending.

### AC-10 — audit log rotates at midnight UTC

Unit-tested at T-0007 with a synthetic midnight; live verification requires either:

1. Leave a daemon running across a real UTC midnight. After midnight, verify:
   - `~/.claude-bridge/audit.jsonl` is the new day's file (small)
   - `~/.claude-bridge/audit-YYYY-MM-DD.jsonl` is the previous day's file (renamed)
   - Files older than `audit.retention_days` are pruned
2. Build a clock-fake harness that simulates midnight without waiting — out of scope for P0.

Marked MANUAL-VERIFIED-AT-GATE in milestones.md.

## Running the acceptance harness

The full P0 gate test:

```bash
cd packages/cli
npm run acceptance
```

Or directly:

```bash
pwsh scripts/acceptance-p0.ps1
# fallback on Windows PowerShell 5.1:
powershell -ExecutionPolicy Bypass -File scripts/acceptance-p0.ps1
```

What it does, in order: cold-wipes `~/.claude-bridge/`; starts the daemon; verifies status; runs an MCP ping via `scripts/mcp-ping-client.mjs`; checks the audit log for the success entry; sends a wrong token and verifies the rejection audit entry; kills cloudflared and verifies respawn within 30s with a new URL; stops the daemon; restarts; rotates the token and verifies old=401 / new=200; reports the final summary.

Expected outcome: `ALL P0 ACCEPTANCE CRITERIA PASSED (8 verified mechanically; 2 skipped with notes)`.

Pre-requisites: `claude-bridge` on PATH (via `npm link`); `cloudflared` on PATH or at a well-known Windows install location; `node` on PATH; network connectivity for the tunnel.
