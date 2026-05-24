#!/usr/bin/env bash
# Phase 12 owns full Unix-host exercise of the live SMOKE harness; this
# wrapper exists for parity. Phase 12 will add any Linux/WSL-specific
# pre-flight (PATH augmentation, port-check, etc.) — same shape as the
# acceptance-p1.sh wrapper, refined as Phase 12 surfaces specifics.
#
# Requires ANTHROPIC_API_KEY in env (caller's responsibility to set + pass).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "ANTHROPIC_API_KEY not set in env; aborting." >&2
    exit 2
fi

exec node scripts/acceptance-p1-smoke.mjs "$@"
