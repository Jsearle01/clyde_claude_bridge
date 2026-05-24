#!/usr/bin/env bash
# Phase 12 owns full Unix-host exercise; this wrapper exists for parity
# and to be filled in at Phase 12 (env setup, cloudflared path resolution
# on Linux/macOS, etc.). For now: invokes the platform-agnostic harness.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
exec node scripts/acceptance-p1.mjs "$@"
