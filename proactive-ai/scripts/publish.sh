#!/usr/bin/env bash
# Publish proactive-ai OpenClaw plugin to npm.
#
# Usage:
#   ./scripts/publish.sh              # publish current version
#   ./scripts/publish.sh patch        # bump patch, then publish
#   ./scripts/publish.sh minor        # bump minor, then publish
#   ./scripts/publish.sh major        # bump major, then publish
#   ./scripts/publish.sh --dry-run    # build + pack only (no publish)
#
set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN=false
BUMP=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    patch|minor|major) BUMP="$arg" ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

# ── Preflight ──
echo "==> Preflight checks..."

# Ensure logged in to npm
if ! npm whoami &>/dev/null; then
  echo "Error: not logged in to npm. Run: npm login"
  exit 1
fi

# Ensure clean working tree (optional but recommended)
if [[ -n "$(git status --porcelain .)" ]]; then
  echo "Warning: uncommitted changes in proactive-ai/"
  echo "  Press Enter to continue or Ctrl-C to abort."
  read -r
fi

# ── Version bump (if requested) ──
if [[ -n "$BUMP" ]]; then
  echo "==> Bumping version: $BUMP"
  npm version "$BUMP" --no-git-tag-version
fi

VERSION=$(node -p "require('./package.json').version")
echo "==> Version: $VERSION"

# ── Clean + Build ──
echo "==> Building..."
npm run clean
npm run build

# ── Verify dist output ──
if [[ ! -f dist/ui/index.html ]]; then
  echo "Error: dist/ui/index.html not found after build (frontend build failed)"
  exit 1
fi

if [[ ! -f dist/index.js ]]; then
  echo "Error: dist/index.js not found after build (backend build failed)"
  exit 1
fi

if [[ ! -f dist/index.d.ts ]]; then
  echo "Warning: dist/index.d.ts not found (declaration generation may have failed)"
fi

# ── Verify openclaw.plugin.json is included ──
if [[ ! -f openclaw.plugin.json ]]; then
  echo "Error: openclaw.plugin.json missing"
  exit 1
fi

# ── Pack (always, to inspect) ──
echo "==> Packing..."
TARBALL=$(npm pack --pack-destination /tmp 2>&1 | tail -1)
echo "  Tarball: $TARBALL"
echo "  Contents:"
tar tzf "/tmp/$TARBALL" | head -30
echo "  ..."

if $DRY_RUN; then
  echo ""
  echo "==> Dry run complete. Tarball at: /tmp/$TARBALL"
  echo "  To inspect: tar tzf /tmp/$TARBALL"
  exit 0
fi

# ── Publish ──
echo ""
PACKAGE_NAME=$(node -p "require('./package.json').name")
echo "==> Publishing $PACKAGE_NAME@$VERSION to npm..."
npm publish --access public

echo ""
echo "==> Done! Install in OpenClaw:"
echo "  openclaw plugins install $PACKAGE_NAME@$VERSION"
