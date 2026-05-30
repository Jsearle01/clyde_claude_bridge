#!/usr/bin/env bash
# T-P2-012 AC #4: structural .vsix verification on WSL. Unpacks the
# packaged extension to /tmp, asserts presence of dist/extension.js
# + valid package.json, and greps for any externally-imported
# @claude-bridge/* references (must return 0).

set -u
# Use portable Node install if present so callers can omit a .bashrc PATH
# export. Works whether or not invoked via login shell.
if [ -x "$HOME/node-v20/bin/node" ]; then
  export PATH="$HOME/node-v20/bin:$PATH"
fi
VSIX="/mnt/c/projects/clyde_claude_bridge/packages/extension/claude-bridge-extension-0.1.0.vsix"
TMP="$(mktemp -d)"
echo "vsix: $VSIX"
echo "tmp:  $TMP"

if [ ! -f "$VSIX" ]; then
  echo "VSIX NOT FOUND" >&2
  exit 1
fi

# .vsix is a zip; unzip with -o overwrite, -q quiet.
cp "$VSIX" "$TMP/ext.zip"
# WSL Ubuntu lacks `unzip` by default but Python 3 ships with zipfile.
# Using `python3 -m zipfile -e` avoids needing apt install at validation
# time.
python3 -m zipfile -e "$TMP/ext.zip" "$TMP/unpacked"

echo "--- unpacked tree ---"
find "$TMP/unpacked" -type f | sort

DIST="$TMP/unpacked/extension/dist/extension.js"
PKG="$TMP/unpacked/extension/package.json"

echo "--- dist/extension.js stat ---"
if [ -f "$DIST" ]; then
  ls -la "$DIST"
else
  echo "MISSING: $DIST"
  exit 1
fi

echo "--- package.json validity ---"
if [ -f "$PKG" ]; then
  if node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log('valid JSON')" "$PKG"; then
    :
  else
    echo "INVALID JSON in package.json"
    exit 1
  fi
else
  echo "MISSING: $PKG"
  exit 1
fi

echo "--- @claude-bridge/ grep on dist/extension.js ---"
COUNT="$(grep -c "@claude-bridge/" "$DIST" || true)"
echo "matches=$COUNT"
if [ "$COUNT" -ne 0 ]; then
  echo "FAIL: bundle has external @claude-bridge/ references"
  exit 1
fi
echo "PASS: 0 external @claude-bridge/ references in bundled output"

rm -rf "$TMP"
