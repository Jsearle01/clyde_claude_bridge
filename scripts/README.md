# scripts/

Dev / verification scripts. Not user-facing; not shipped in any package.

| Script | Purpose | When to run |
|---|---|---|
| `verify-install.ps1` | `npm link` from `packages/cli/` + smoke-check `claude-bridge --version` / `--help` from a non-repo directory | After first build, or whenever the bin entry changes |
| `mcp-ping-client.mjs` | Throwaway Node helper that drives the daemon over MCP using `@modelcontextprotocol/sdk` (initialize → list-tools → call-tool). Invoked by `acceptance-p0.ps1`; supports a `--expect-401` mode for auth-rejection tests | Called from acceptance harness — not intended for direct use |
| `acceptance-p0.ps1` | Walks all 10 P0 acceptance criteria from `docs/01-p0-bus.md` mechanically; PASS/SKIP/FAIL per step; exits non-zero on first FAIL | P0 gate review; whenever the bus surface changes |

Run examples:

```powershell
pwsh -File scripts/verify-install.ps1
pwsh -File scripts/acceptance-p0.ps1
```

`powershell.exe` 5.1 works for both (the scripts target `#requires -Version 5.1`). `pwsh` (PowerShell 7+) is preferred when available.

The acceptance harness assumes `claude-bridge` is on PATH — run `verify-install.ps1` first if needed.
