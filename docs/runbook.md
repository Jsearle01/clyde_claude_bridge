# claude-bridge runbook

Operational reference. Pairs with the project [README](../README.md) (what is this, how to install) — this doc covers "I have it running; how do I work with it; what do I do when X breaks."

Sections are arranged operator-flow-first: prerequisites and install at the top; lifecycle, config, files; then the P1 delegation surface (`delegate_to_claude_code` / `poll_delegation` / `cancel_delegation`); troubleshooting at the end. The [walkthrough](walkthrough.md) covers internals and design narrative for contributors; the [design doc](design/02-p1-delegation.md) covers rationale.

## Prerequisites

| Item | Required | Notes |
|---|---|---|
| OS | Yes | Windows 10/11 and WSL Ubuntu (validated through P1). Linux distros and macOS are untested but should work given POSIX paths + cross-platform discipline (CC-1 through CC-6 in the methodology); please report results. |
| Node.js | Yes | **20.19+ recommended.** 20.18 works for the daemon and SDK runtime, but `undici@8.x` (transitive dev-dep) crashes at module load on 20.18 — the harness scripts degrade gracefully (see [Troubleshooting → "undici unavailable" warning](#undici-unavailable-warning)). 20.10 is the daemon's hard floor (P0 baseline). |
| Git | Yes | Snapshot/diff computation uses `git ls-files` and `git diff` when the workspace is a git repo; falls back to package-based walking and diff for non-git workspaces. |
| cloudflared | Optional | Required only for tunneled MCP access (Claude.ai, remote clients). For localhost-only use (MCP Inspector on the same host, acceptance harnesses), the daemon still spawns cloudflared at startup unless `tunnel.binary` is overridden — see [cloudflared per OS](#cloudflared-installation-per-os). |
| ANTHROPIC_API_KEY | Required for live delegation | Get from console.anthropic.com. The daemon's child process inherits the env var of the shell that spawned it. Never written to disk by claude-bridge. Without the key, `delegate_to_claude_code` calls reach the SDK runner and fail at runtime with `error.category: "auth"`. |

## Installation

```bash
git clone https://github.com/Jsearle01/clyde_claude_bridge.git
cd clyde_claude_bridge
npm install
npm run build
```

`npm install` may take 1-2 minutes the first time. The SDK package (`@anthropic-ai/claude-agent-sdk@^0.3.150`) is a normal npm dependency — no extra binary fetch is required at install time. The SDK lazily resolves the Claude Code runtime when a delegation actually runs.

For developer convenience, link the CLI globally:

```bash
cd packages/cli
npm link
```

Then `claude-bridge --version` from any directory.

To uninstall: `npm unlink -g @claude-bridge/cli` (see [Uninstallation](#uninstallation) at the bottom of this doc for full cleanup).

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

### Workspace block (P1)

P1 ships with a stub workspace registry: a single workspace is configured in `config.json` and matched by ID. The P2 VS Code extension will replace the stub with a real registry where workspaces register themselves at attach time.

Add a `workspace` block to enable delegations:

```json
{
  "workspace": {
    "id": "local#default",
    "abs_path": "/home/you/projects/your-repo",
    "default_mode": "agentic"
  }
}
```

- `id` — opaque string; the only constraint is uniqueness across multi-workspace registries (P2). For the stub, anything matches via exact-string compare.
- `abs_path` — absolute path to the workspace root. Must exist and be a directory. Symlinks are resolved at config load time (CC-1).
- `default_mode` — `"agentic"` (writes allowed via the SDK) or `"read_only"` (writes blocked by `disallowedTools` belt-and-suspenders — see [walkthrough P1 §8](walkthrough.md#sdk-integration)).

When no `workspace` block is present, `delegate_to_claude_code` returns `503 no_workspace_configured`; `ping` continues to work.

### Stub-config block (development only)

The daemon also accepts an undocumented-by-design `stub_behavior` block for harness/test work. It requires the `--allow-stub-config` flag and forces the StubJobRunner runner regardless of `workspace`. Leave it absent in production configs.

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

P1 adds the transcripts subdirectory:

| Path | Purpose |
|---|---|
| `~/.claude-bridge/transcripts/` | One JSONL file per delegation, named `{job_id}.jsonl` (mode 0700 dir on Unix; mode 0600 per file) |

The transcripts dir is created lazily on first delegation. Orphan handling (T-P1-006) sweeps stale transcripts at daemon startup based on the JobQueue's retained job IDs — but P1 has no persistent job state across daemon restarts, so all transcripts present at startup are treated as orphans of prior runs and left in place for forensic recovery. Manual cleanup is the user's job; the runbook's [Uninstallation](#uninstallation) section covers full directory removal.

## Operating delegations (P1)

P1 ships three MCP tools that compose into a single delegation lifecycle: `delegate_to_claude_code` enqueues work; `poll_delegation` retrieves progress and final report; `cancel_delegation` aborts. All three are exposed at the `/mcp` endpoint and require the same Bearer token used by `ping`.

### `delegate_to_claude_code`

Inputs (Zod-validated at the MCP boundary):

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string (non-empty) | yes | The instruction Claude Code receives. No size cap enforced by claude-bridge in P1 (SDK and Anthropic API enforce real limits). |
| `workspace` | string | no | If absent, the configured workspace is used. If present, it must match an attached workspace ID (P1: the stub's single ID). Mismatch → `404 workspace_not_found`. |
| `mode` | `"agentic"` \| `"read_only"` | no | Defaults to the workspace's `default_mode`. |
| `max_turns` | integer 1-200 | no | Defaults to 50. Hits the SDK's `maxTurns` directly. Exceeding triggers truncation. |
| `working_directory` | string | no | Subdirectory of the workspace, used as the SDK's `cwd`. Absolute paths rejected (`working_directory_absolute`); `..` escapes rejected (`working_directory_escapes_workspace`). |
| `exhibits` | array | no | Up to 100 inline files (≤256KB total) appended to the prompt as `--- EXHIBIT: <path> ---` blocks. |
| `model` | string | no | Override the SDK's default model. |

Response shape on success:

```json
{
  "job_id": "j_FJ7QBO3X7LQO",
  "status": "queued",
  "workspace_id": "local#default",
  "queued_position": 0
}
```

`queued_position: 0` means "first in the FIFO behind any currently-running job." With the single-concurrent runner, position 0 typically means "will start immediately when the runner picks the next job."

### `poll_delegation`

Inputs:

| Field | Type | Required | Notes |
|---|---|---|---|
| `job_id` | string | yes | The ID returned by `delegate_to_claude_code`. |
| `wait_ms` | integer 0-60000 | no | Long-poll budget. Defaults to 0 (non-blocking). Capped at 60000 by the schema. |

Behavior: returns immediately if the job is terminal (`complete` / `failed` / `cancelled`); otherwise waits until terminal or `wait_ms` elapses, whichever comes first. Resolution is event-driven via the JobQueue's terminal-promise primitive — no busy-wait.

Recommended polling pattern: long-poll with `wait_ms: 30000-60000`. Re-poll on `running` until terminal. Short polls (`wait_ms: 0` or `< 1000`) work for "what's the current state" checks but burn round-trips during long delegations.

Response shape (running):

```json
{
  "job_id": "j_FJ7QBO3X7LQO",
  "status": "running",
  "workspace_id": "local#default",
  "partial": {
    "turns_so_far": 3,
    "last_tool": "Write",
    "elapsed_ms": 4521
  }
}
```

Response shape (terminal): includes `report` with the full `DelegationReport` (see below).

### `cancel_delegation`

Inputs:

| Field | Type | Required |
|---|---|---|
| `job_id` | string | yes |

Behavior: flips `cancel_requested` on the job. If the job is queued, transitions to `cancelled` immediately. If running, signals the SDK via the runner's AbortController; terminal `cancelled` state reached within ~2 seconds typical (T-P1-012 measured 1.4s WSL / 2.2s Windows; 15s budget per AC-8 in design doc).

Response shape:

```json
{
  "job_id": "j_FJ7QBO3X7LQO",
  "status": "cancelled",
  "prior_status": "running"
}
```

### Interpreting `DelegationReport`

When the job reaches `complete`, `failed`, or `cancelled`, the next poll returns the report in the response's `report` field:

```json
{
  "job_id": "j_FJ7QBO3X7LQO",
  "summary": "Created hello.txt at workspace root with content 'hi from claude-code'.",
  "files_created": ["hello.txt"],
  "files_modified": [],
  "files_deleted": [],
  "diff": "diff --git a/hello.txt b/hello.txt\nnew file mode 100644\n...",
  "shell_commands": [],
  "tool_calls_made": 2,
  "turns": 1,
  "duration_ms": 9334,
  "truncated": false,
  "truncation_reason": null,
  "error": null,
  "transcript_uri": "file:///home/you/.claude-bridge/transcripts/j_FJ7QBO3X7LQO.jsonl"
}
```

Field-by-field:

| Field | What it tells you |
|---|---|
| `summary` | Backward-walk-derived string from the last assistant message's text content. Empty string if the SDK produced no text. |
| `files_created` / `files_modified` / `files_deleted` | Computed from the before/after workspace snapshot pair (taken at delegation start and end). Binary files are listed by path even when excluded from `diff`. |
| `diff` | Unified text diff of the workspace state change. Truncated at 256KB per file. Empty string if no changes. |
| `shell_commands` | Bash invocations extracted from the transcript's `tool_use` blocks: `[{cmd, exit_code}]`. |
| `tool_calls_made` | Count of all SDK tool invocations across the run. |
| `turns` | Assistant-message count. May be less than `max_turns`. |
| `duration_ms` | Wall-clock duration from runner-claim to terminal. |
| `truncated` / `truncation_reason` | If `truncated: true`, one of `"timeout"` \| `"max_turns"` \| `"transcript_size"` \| `"workspace_size"` (precedence in that order — T-P1-008). |
| `error` | `null` on `complete`; structured `ErrorDetail` on `failed` / `cancelled`: `{category, message, details}`. Categories: `"auth"` \| `"permission"` \| `"timeout"` \| `"cancelled"` \| `"internal"` \| `"sdk_runtime"`. |
| `transcript_uri` | `file://` URL to the full JSONL transcript. Survives daemon restart. |

The transcript is the authoritative record of what happened; the report is a derived summary. When in doubt about a delegation's behavior, read the transcript.

### Audit trail

Each MCP tool invocation produces one audit log entry in `~/.claude-bridge/audit.jsonl` with `tool`, `request_id`, `allowed`, `duration_ms`, plus P1 additions `job_id` and `workspace_id` (when present in the tool's context). The job completing does **not** produce a separate audit entry — the audit is on tool calls, not on job lifecycle events. To trace a delegation end-to-end: filter audit entries by `job_id`.

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

### WSL pre-flight checklist

Before running the daemon or the acceptance harness on WSL Ubuntu (or any Linux that has previously held stale state from another host or another Node version), do the defensive clean install:

```bash
cd ~/claude-bridge-wsl   # or wherever your WSL checkout lives
rm -rf node_modules packages/*/node_modules
find packages -name "*.tsbuildinfo" -delete
npm install
npm run build
```

Reasoning (CC-4): incremental npm installs across Node versions or platforms can leave orphaned files (T-P1-010 hit `.d.ts.map` files without their `.d.ts` siblings, breaking `tsc -b`). Clean install costs ~30 seconds and prevents an entire class of confusing failures.

Also: cloudflared must be reachable. The harness's `ensureCloudflaredOnPath` (T-P1-012) probes `~/cloudflared`, `/usr/local/bin/cloudflared`, and `/usr/bin/cloudflared`. If your install lives elsewhere, either symlink it to one of those paths or set `tunnel.binary` in the test config.

### "undici unavailable" warning

When you see this on stderr while running the MCP delegate client (or any harness that loads it):

```
[mcp-client] undici unavailable; DNS workaround disabled — localhost is fine;
trycloudflare hostnames may fail to resolve.
(webidl.util.markAsUncloneable is not a function)
```

This is **benign for localhost-only setups.** It means `undici@8.x` failed to load — almost always because your Node is below the `>=22.19` engine requirement, with WSL Ubuntu's stock Node 20.18 the dominant case. The MCP client lazy-loads undici and degrades gracefully: localhost MCP connections work; the DNS workaround for newly-issued `*.trycloudflare.com` URLs (T-0019) is disabled.

If you actually need the workaround (e.g., your client targets a tunnel URL whose DNS hasn't propagated through your local resolver), upgrade Node:

```bash
# In WSL: replace the user-local install with Node 20.19+ or 22 LTS
cd ~
rm -rf node-v20
wget https://nodejs.org/dist/v20.19.0/node-v20.19.0-linux-x64.tar.xz
tar xf node-v20.19.0-linux-x64.tar.xz
mv node-v20.19.0-linux-x64 node-v20
# PATH already augmented; re-source your shell if needed
```

Or pin the system Node via your distro's package manager. After upgrade, the warning disappears and the DNS workaround re-enables transparently.

### cloudflared installation per OS

| OS | Recommended | Path |
|---|---|---|
| Windows | Official installer from cloudflare.com/docs | `C:\Program Files (x86)\cloudflared\cloudflared.exe` (harness auto-detects this path) |
| WSL Ubuntu / Debian | `cloudflared` apt package or user-local tarball | `/usr/bin/cloudflared` (apt) or `~/cloudflared` (user-local, T-0019.6 pattern) |
| Linux (other) | Distro package or static binary from Cloudflare GitHub releases | `/usr/local/bin/cloudflared` |
| macOS | `brew install cloudflared` (untested at P1; should work) | `/usr/local/bin/cloudflared` (Intel) or `/opt/homebrew/bin/cloudflared` (Apple Silicon — the harness does not yet probe this path; symlink it to `~/cloudflared` as a workaround) |

To override the path explicitly without depending on auto-detection, set `tunnel.binary` in `config.json` to the absolute path of the binary.

### Node engine guidance

The matrix:

| Use case | Floor | Recommended |
|---|---|---|
| Daemon runtime | 20.10 | 20.19+ |
| SDK runtime (delegations) | 20.18 (warns) | 20.19+ |
| MCP delegate client (undici-based DNS workaround) | 22.19 | 22 LTS |
| Acceptance harnesses (localhost MCP) | 20.10 | 20.19+ (warning-free) |

20.10 is the P0 daemon floor. Below that, native ESM dynamic-import semantics differ enough to risk runtime surprises. 20.19 is the recommended floor for the SDK runtime to silence the engine warning. 22.19 is undici@8's hard floor.

If you can choose a single version, **Node 22 LTS** satisfies everything cleanly.

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

### P1 harnesses

P1 ships two harnesses, both under `scripts/`:

```bash
# StubJobRunner via MCP — no API key needed; 9 mechanical ACs in ~7s
pwsh scripts/acceptance-p1.ps1            # Windows
bash scripts/acceptance-p1.sh             # Linux / WSL

# SdkJobRunner via MCP against the real Anthropic API — ~1-2 min, ~$0.30 in credits
ANTHROPIC_API_KEY="sk-ant-..." pwsh scripts/acceptance-p1-smoke.ps1
ANTHROPIC_API_KEY="sk-ant-..." bash scripts/acceptance-p1-smoke.sh
```

Both wrappers invoke the same `.mjs` core. The SMOKE harness aborts with exit 2 if `ANTHROPIC_API_KEY` is absent from the invoking shell.

Cross-platform parity was verified at T-P1-012: Windows and WSL both produce identical PASS counts on both harnesses. Per-AC elapsed varies (Claude's model nondeterminism on read_only delegations can produce 5x wall-time variance between runs — neither is wrong).

## Uninstallation

Stop the daemon and remove state:

```bash
claude-bridge stop          # idempotent; exit 0 if not running
rm -rf ~/.claude-bridge/    # config, audit, transcripts, sockets, pidfile
```

On Windows: `Remove-Item -Recurse -Force "$env:APPDATA\claude-bridge"`.

Remove the global CLI link (if installed):

```bash
cd packages/cli
npm unlink -g @claude-bridge/cli
```

Remove the repo: `rm -rf /path/to/clyde_claude_bridge`.

The daemon's audit and transcript directories are the only state outside the repo. After removing `~/.claude-bridge/` and unlinking the CLI, claude-bridge leaves no trace on the host.
