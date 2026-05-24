# Windows wrapper for the P1 live SMOKE harness (Phase 11).
#
# Prerequisites:
#   - Node 20+ on PATH
#   - daemon package built (`npm run build --workspace @claude-bridge/daemon`)
#   - ANTHROPIC_API_KEY in the invoking shell's env (the harness
#     forwards it to the daemon child process; never logs the value)
#
# Pre-flight: stop any running daemon to free the default 7423 port and
# the Windows named pipe used for IPC. Matches T-P1-005's pattern.

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot

# Pre-flight: stop any existing daemon. claude-bridge stop is idempotent.
try {
    $stopOutput = & claude-bridge stop 2>&1
    Write-Host "Pre-flight: $stopOutput"
    Start-Sleep -Milliseconds 500
} catch {
    Write-Host "Pre-flight: no claude-bridge on PATH or stop failed; continuing"
}

if (-not $env:ANTHROPIC_API_KEY) {
    Write-Host "ANTHROPIC_API_KEY not set in current shell; aborting."
    exit 2
}

Push-Location $repoRoot
try {
    & node "scripts/acceptance-p1-smoke.mjs" @args
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
