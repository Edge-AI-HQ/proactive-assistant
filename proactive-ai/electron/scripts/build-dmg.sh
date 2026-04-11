#!/bin/bash
# ------------------------------------------------------------------
# build-dmg.sh — Build a self-contained Proactive AI DMG for macOS.
#
# Produces:  proactive-ai/electron/out/make/*.dmg
#
# What gets bundled:
#   .bundle/plugin/   — proactive-ai plugin (TS source + compiled CLI +
#                       single-file UI + skills + production node_modules
#                       with native deps rebuilt for bundled Node)
#   .bundle/runtime/  — Node 22.x binary + openclaw CLI
#
# Environment variables (all optional):
#   BUNDLE_NODE_VERSION     — Node.js version to bundle (default: 22.16.0)
#   BUNDLE_OPENCLAW_VERSION — openclaw version to bundle (default: 2026.4.5)
#   SKIP_SIGN=1             — skip code signing & notarization (faster builds)
#
# Usage:
#   bash proactive-ai/electron/scripts/build-dmg.sh
#   SKIP_SIGN=1 bash proactive-ai/electron/scripts/build-dmg.sh
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

BUNDLE="$ELECTRON_DIR/.bundle"

echo "==> Proactive: $PROACTIVE_DIR"
echo "==> Arch:      $NODE_ARCH"
echo "==> Node:      v$NODE_VER"
echo "==> OpenClaw:  $OPENCLAW_VER"
echo ""

# ── Clean previous bundle ──

rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/plugin/bin" "$BUNDLE/plugin/src" "$BUNDLE/plugin/dist/ui" "$BUNDLE/runtime"

# ── Step 1: Build proactive-ai (server TS + single-file UI) ──

echo "==> [1/5] Building proactive-ai..."
npm run build --prefix "$PROACTIVE_DIR"
echo "  dist/src/cli/bin.js exists: $([ -f "$PROACTIVE_DIR/dist/src/cli/bin.js" ] && echo yes || echo NO)"
echo "  dist/ui/index.html exists:  $([ -f "$PROACTIVE_DIR/dist/ui/index.html" ] && echo yes || echo NO)"

# ── Step 2: Assemble plugin bundle ──

echo "==> [2/5] Assembling plugin bundle..."
cd "$BUNDLE/plugin"

# Plugin entry + manifest
cp "$PROACTIVE_DIR/index.ts" .
cp "$PROACTIVE_DIR/openclaw.plugin.json" .

# CLI entry point
cp "$PROACTIVE_DIR/bin/pin" bin/
chmod +x bin/pin

# Server-side source (.ts — jiti will transpile at runtime)
# Copy everything except ui/ and test files
rsync -a \
  --exclude='ui/' \
  --exclude='*.test.ts' \
  --exclude='test/' \
  "$PROACTIVE_DIR/src/" src/

# Compiled CLI (for bin/pin to import directly, avoiding tsx fallback)
if [ -d "$PROACTIVE_DIR/dist/src" ]; then
  mkdir -p dist/src
  rsync -a "$PROACTIVE_DIR/dist/src/" dist/src/
fi

# Compiled plugin entry (dist/index.js)
[ -f "$PROACTIVE_DIR/dist/index.js" ] && cp "$PROACTIVE_DIR/dist/index.js" dist/
[ -f "$PROACTIVE_DIR/dist/index.d.ts" ] && cp "$PROACTIVE_DIR/dist/index.d.ts" dist/

# Skill documentation (used by OpenClaw agents)
cp -r "$PROACTIVE_DIR/skills" .

# Static assets (fallback for assets route; mostly inlined by Vite singlefile)
[ -d "$PROACTIVE_DIR/public" ] && cp -r "$PROACTIVE_DIR/public" .

# Built single-file UI
cp "$PROACTIVE_DIR/dist/ui/index.html" dist/ui/

# Minimal package.json — production runtime deps only
cat > package.json <<'PKGJSON'
{
  "name": "proactive-ai-plugin-bundle",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "bin": {
    "pin": "./bin/pin"
  },
  "dependencies": {
    "@lancedb/lancedb": "^0.27.2",
    "better-sqlite3": "^12.8.0",
    "commander": "^12.1.0",
    "drizzle-orm": "^0.45.2",
    "openai": "^6.33.0"
  }
}
PKGJSON

echo "  Installing plugin dependencies (production only)..."
npm install --omit=dev 2>&1 | tail -5
echo "  plugin node_modules: $(du -sh node_modules | cut -f1)"

# ── Step 3: Download Node.js binary ──

echo "==> [3/5] Downloading Node.js v${NODE_VER} (darwin-${NODE_ARCH})..."
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

# Rebuild native modules against the bundled Node version
echo "  Rebuilding native modules for bundled Node..."
cd "$BUNDLE/plugin"
npx --yes node-gyp-build 2>/dev/null || true
# Rebuild better-sqlite3 specifically (critical native dep)
if [ -d "node_modules/better-sqlite3" ]; then
  cd node_modules/better-sqlite3
  "$BUNDLE/runtime/node" "$(which npx)" --yes prebuild-install -r napi --force 2>/dev/null \
    || npm run build-release 2>&1 | tail -5 \
    || echo "  WARNING: better-sqlite3 native rebuild skipped (may use prebuilt)"
  cd "$BUNDLE/plugin"
fi

# ── Step 4: Install openclaw into runtime ──

echo "==> [4/5] Installing openclaw ($OPENCLAW_VER)..."
cd "$BUNDLE/runtime"

# Create a minimal package.json so npm installs HERE, not in a parent directory
cat > package.json <<'RTJSON'
{ "name": "proactive-ai-runtime", "version": "1.0.0", "private": true }
RTJSON

# Install openclaw as a local package (provides node_modules/.bin/openclaw)
npm install "openclaw@${OPENCLAW_VER}" --omit=dev 2>&1 | tail -5
echo "  runtime total: $(du -sh "$BUNDLE/runtime" | cut -f1)"

# ── Step 5: Build Electron + make DMG ──

echo "==> [5/5] Building DMG..."
cd "$ELECTRON_DIR"

# Ensure electron deps are installed
echo "  [5a] Installing Electron dependencies..."
npm install 2>&1 | tail -5

# Compile Electron TypeScript
echo "  [5b] Compiling Electron TypeScript..."
npm run build

# Package into DMG
echo "  [5c] Packaging with electron-forge (this may take a while)..."
npx electron-forge make

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
