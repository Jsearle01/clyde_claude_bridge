# Verifies the `claude-bridge` bin entry is reachable globally after `npm link`.
# Does NOT start the daemon — that's T-0019's acceptance test. This script
# only proves the shebang + bin + PATH resolution work end-to-end.
#
# Usage (from repo root):
#   pwsh -File scripts/verify-install.ps1
#
# Cleanup is the caller's responsibility (`npm unlink -g @claude-bridge/cli`).

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$cliDir = Join-Path $repoRoot "packages\cli"
$expectedVersion = (Get-Content (Join-Path $cliDir "package.json") -Raw |
    ConvertFrom-Json).version

function Fail([string]$msg) {
    Write-Host "FAIL: $msg" -ForegroundColor Red
    exit 1
}

function Pass([string]$msg) {
    Write-Host "PASS: $msg" -ForegroundColor Green
}

Write-Host "verify-install: linking @claude-bridge/cli from $cliDir"
Push-Location $cliDir
try {
    $linkOutput = & npm link 2>&1
    if ($LASTEXITCODE -ne 0) {
        Fail "npm link failed (exit $LASTEXITCODE):`n$linkOutput"
    }
    Pass "npm link succeeded"
} finally {
    Pop-Location
}

# Resolve the linked bin and run it from a directory that's NOT the repo,
# so we prove the global PATH entry works rather than a local node_modules
# resolution.
$cmd = Get-Command claude-bridge -ErrorAction SilentlyContinue
if ($null -eq $cmd) {
    Fail "claude-bridge not on PATH after npm link"
}
Pass "claude-bridge resolves to $($cmd.Source)"

Push-Location ([System.IO.Path]::GetTempPath())
try {
    $versionOutput = & claude-bridge --version 2>&1
    if ($LASTEXITCODE -ne 0) {
        Fail "claude-bridge --version exited $LASTEXITCODE :`n$versionOutput"
    }
    $version = ($versionOutput | Out-String).Trim()
    if ($version -ne $expectedVersion) {
        Fail "version mismatch: expected '$expectedVersion', got '$version'"
    }
    Pass "claude-bridge --version -> $version"

    $helpOutput = & claude-bridge --help 2>&1
    if ($LASTEXITCODE -ne 0) {
        Fail "claude-bridge --help exited $LASTEXITCODE"
    }
    if (($helpOutput | Out-String) -notmatch "Bridge a Claude\.ai project") {
        Fail "claude-bridge --help did not contain expected description"
    }
    Pass "claude-bridge --help printed top-level usage"
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "verify-install: all checks passed" -ForegroundColor Green
Write-Host "To unlink: npm unlink -g @claude-bridge/cli"
