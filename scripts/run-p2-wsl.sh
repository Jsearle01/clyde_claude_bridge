#!/usr/bin/env bash
# T-P2-012: WSL harness driver. Sets PATH for portable Node + cloudflared,
# then runs the P2 acceptance harness. Sourced by the dispatch session;
# safe to delete after T-P2-012 closes if no recurring WSL run is needed.

set -e
export PATH="$HOME/node-v20/bin:$HOME:$PATH"
cd /mnt/c/projects/clyde_claude_bridge
echo "node $(node --version), platform $(node -e 'console.log(process.platform)')"
exec node scripts/acceptance-p2.mjs "$@"
