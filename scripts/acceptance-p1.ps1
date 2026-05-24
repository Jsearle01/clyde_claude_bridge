# Windows wrapper for the P1 acceptance harness. Phase 5 deliverable;
# this is what runs for gate evidence.
#
# Prerequisites: Node 20+ on PATH; cloudflared installed (the harness
# auto-augments PATH with the well-known Windows install path); daemon
# package built (`npm run build --workspace @claude-bridge/daemon`).
#
# Pre-flight: stop any running daemon to free the default 7423 port and
# the Windows named pipe used for IPC. Matches P0's acceptance pattern.

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

# Invoke the .mjs harness. Working directory = repo root so relative
# require paths resolve.
Push-Location $repoRoot
try {
    & node "scripts/acceptance-p1.mjs" @args
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
