#!/bin/bash
# ------------------------------------------------------------------
# build-dmg.sh — Build a self-contained Proactive AI DMG for macOS.
#
# Produces:  proactive-ai/electron/out/make/*.dmg
#
# What gets bundled:
#   .bundle/plugin/   — proactive-ai plugin source + pin-cli + native deps
#   .bundle/runtime/  — Node 22.x binary + openclaw CLI
#
# Environment variables (all optional):
#   BUNDLE_NODE_VERSION     — Node.js version to bundle (default: 22.16.0)
#   BUNDLE_OPENCLAW_VERSION — openclaw version to bundle (default: latest)
#
# Usage:
#   bash proactive-ai/electron/scripts/build-dmg.sh
# ------------------------------------------------------------------
set -euo pipefail

[[ "$(uname -s)" != "Darwin" ]] && { echo "ERROR: This script is macOS-only."; exit 1; }

NODE_VER="${BUNDLE_NODE_VERSION:-22.16.0}"
OPENCLAW_VER="${BUNDLE_OPENCLAW_VERSION:-2026.4.5}"
ARCH=$(uname -m)
[[ "$ARCH" == "x86_64" ]] && NODE_ARCH=x64 || NODE_ARCH=arm64

# ── Resolve paths ──

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ELECTRON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROACTIVE_DIR="$(cd "$ELECTRON_DIR/.." && pwd)"
ROOT="$(cd "$PROACTIVE_DIR/.." && pwd)"

BUNDLE="$ELECTRON_DIR/.bundle"

echo "==> Root:       $ROOT"
echo "==> Arch:       $NODE_ARCH"
echo "==> Node:       v$NODE_VER"
echo "==> OpenClaw:   $OPENCLAW_VER"
echo ""

# ── Clean previous bundle ──

rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/plugin/src" "$BUNDLE/plugin/dist/ui" "$BUNDLE/runtime"

# ── Step 1: Build pin-cli ──

echo "==> [1/7] Building pin-cli..."
npm run build --workspace pin-cli --prefix "$ROOT"

# ── Step 2: Build proactive-ai (UI single-file + server TS) ──

echo "==> [2/7] Building proactive-ai..."
npm run build --prefix "$PROACTIVE_DIR"

# ── Step 3: Pack pin-cli as installable tarball ──

echo "==> [3/7] Packing pin-cli..."
cd "$ROOT/pin-cli"
PIN_CLI_TGZ=$(npm pack --json --pack-destination "$BUNDLE" | node -e "
  let d='';process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>console.log(JSON.parse(d)[0].filename));
")
[[ -f "$BUNDLE/$PIN_CLI_TGZ" ]] || { echo "ERROR: npm pack failed — $PIN_CLI_TGZ not found"; exit 1; }
echo "  tarball: $PIN_CLI_TGZ"

# ── Step 4: Assemble plugin bundle ──

echo "==> [4/7] Assembling plugin bundle..."
cd "$BUNDLE/plugin"

# Plugin entry + manifest
cp "$PROACTIVE_DIR/index.ts" .
cp "$PROACTIVE_DIR/openclaw.plugin.json" .

# Server-side source (.ts — jiti will transpile at runtime)
# Copy everything except ui/ and test files
rsync -a \
  --exclude='ui/' \
  --exclude='*.test.ts' \
  --exclude='test/' \
  "$PROACTIVE_DIR/src/" src/

# Skill documentation (used by OpenClaw agents)
cp -r "$PROACTIVE_DIR/skills" .

# Static assets (fallback for assets route; mostly inlined by Vite singlefile)
[ -d "$PROACTIVE_DIR/public" ] && cp -r "$PROACTIVE_DIR/public" .

# Built single-file UI
cp "$PROACTIVE_DIR/dist/ui/index.html" dist/ui/

# Minimal package.json — runtime deps only (relative file: path)
cat > package.json <<PKGJSON
{
  "name": "proactive-ai-plugin-bundle",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@pin-ai/pin-cli": "file:../$PIN_CLI_TGZ"
  }
}
PKGJSON

echo "  Installing plugin dependencies (production only)..."
npm install --omit=dev --ignore-scripts=false 2>&1 | tail -5
echo "  plugin node_modules: $(du -sh node_modules | cut -f1)"

# ── Step 5: Download Node.js binary ──

echo "==> [5/7] Downloading Node.js v${NODE_VER} (darwin-${NODE_ARCH})..."
TMP_NODE=$(mktemp -d)
curl -fSL "https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-darwin-${NODE_ARCH}.tar.gz" \
  | tar xz --strip-components=1 -C "$TMP_NODE"
cp "$TMP_NODE/bin/node" "$BUNDLE/runtime/node"
chmod +x "$BUNDLE/runtime/node"

[[ -x "$BUNDLE/runtime/node" ]] || { echo "ERROR: Node binary download failed"; exit 1; }

# Verify
BUNDLED_VER=$("$BUNDLE/runtime/node" -v)
echo "  Bundled Node: $BUNDLED_VER"
rm -rf "$TMP_NODE"

# ── Step 6: Install openclaw into runtime ──

echo "==> [6/7] Installing openclaw ($OPENCLAW_VER)..."
cd "$BUNDLE/runtime"

# Install openclaw as a local package (provides node_modules/.bin/openclaw)
npm install "openclaw@${OPENCLAW_VER}" --omit=dev 2>&1 | tail -5
echo "  runtime total: $(du -sh "$BUNDLE/runtime" | cut -f1)"

# ── Step 7: Build Electron + make DMG ──

echo "==> [7/7] Building DMG..."
cd "$ELECTRON_DIR"

# Ensure electron deps are installed
npm install 2>&1 | tail -5

# Compile Electron TypeScript
npm run build

# Package into DMG
npx electron-forge make 2>&1 | tail -20

echo ""
echo "========================================="
echo "  DMG build complete!"
echo "========================================="
echo ""
find "$ELECTRON_DIR/out/make" -name '*.dmg' -exec ls -lh {} \; 2>/dev/null
echo ""
echo "Bundle breakdown:"
echo "  plugin:  $(du -sh "$BUNDLE/plugin" | cut -f1)"
echo "  runtime: $(du -sh "$BUNDLE/runtime" | cut -f1)"
