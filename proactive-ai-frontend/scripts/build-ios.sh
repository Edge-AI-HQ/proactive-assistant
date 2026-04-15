#!/usr/bin/env bash
set -euo pipefail

# Build, archive, export, and upload the iOS app to TestFlight.
# Designed to run in CI (GitHub Actions). Requires ASC_* env vars.
#
# Usage:
#   ./scripts/build-ios.sh          # defaults to dev
#   ./scripts/build-ios.sh dev      # explicit dev
#   ./scripts/build-ios.sh prod     # production

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PROJECT_ROOT/.." && pwd)"
IOS_DIR="$PROJECT_ROOT/ios/App"
ARCHIVE_PATH="$IOS_DIR/build/App.xcarchive"
EXPORT_PATH="$IOS_DIR/build/export"
EXPORT_OPTIONS="$IOS_DIR/build/ExportOptions.plist"
BUILD_LOG="$IOS_DIR/build/xcodebuild.log"

# ── Environment selection ──

ENV="${1:-dev}"
case "$ENV" in
  dev)  ENV_FILE="$REPO_ROOT/apis/.env.dev" ;;
  prod) ENV_FILE="$REPO_ROOT/apis/.env.production" ;;
  *)    echo "Usage: $0 [dev|prod]" >&2; exit 1 ;;
esac

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found" >&2
  exit 1
fi

echo "==> Environment: $ENV"
echo "==> Reading VITE_* from $ENV_FILE"

get_env() { npx @dotenvx/dotenvx get "$1" -f "$ENV_FILE" 2>/dev/null; }

export VITE_API_BASE_URL
export VITE_SUPABASE_URL
export VITE_SUPABASE_PUBLISHABLE_KEY
VITE_API_BASE_URL="$(get_env VITE_API_BASE_URL)"
VITE_SUPABASE_URL="$(get_env VITE_SUPABASE_URL)"
VITE_SUPABASE_PUBLISHABLE_KEY="$(get_env VITE_SUPABASE_PUBLISHABLE_KEY)"

for var in VITE_API_BASE_URL VITE_SUPABASE_URL VITE_SUPABASE_PUBLISHABLE_KEY; do
  if [ -z "${!var}" ]; then
    echo "Error: $var is empty after reading from $ENV_FILE" >&2
    exit 1
  fi
done

echo "    VITE_API_BASE_URL=$VITE_API_BASE_URL"

# ── Validate ASC credentials ──

for var in ASC_API_KEY_PATH ASC_KEY_ID ASC_ISSUER_ID; do
  if [ -z "${!var:-}" ]; then
    echo "Error: $var is not set. Required for signing and upload." >&2
    exit 1
  fi
done

# ── Bump build number ──

echo "==> Bumping build number..."
cd "$IOS_DIR"
agvtool next-version -all > /dev/null
NEW_BUILD=$(agvtool what-version -terse)
echo "    Build number: $NEW_BUILD"

# ── Build frontend ──

echo "==> Building frontend (Capacitor)..."
cd "$PROJECT_ROOT"
VITE_CAPACITOR=1 npx vite build

echo "==> Syncing iOS..."
npx cap sync ios

# ── Verify env vars are embedded ──

echo "==> Verifying build output..."
BUILT_JS="$IOS_DIR/App/public/assets/index-"*.js
if ! grep -q "$VITE_API_BASE_URL" $BUILT_JS 2>/dev/null; then
  echo "Error: VITE_API_BASE_URL not found in built JS — aborting" >&2
  exit 1
fi
echo "    API URL verified in build output"

# ── Archive ──

echo "==> Cleaning previous build..."
rm -rf "$ARCHIVE_PATH" "$EXPORT_PATH"
mkdir -p "$(dirname "$BUILD_LOG")"

echo "==> Creating ExportOptions.plist..."
mkdir -p "$(dirname "$EXPORT_OPTIONS")"
cat > "$EXPORT_OPTIONS" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>teamID</key>
    <string>7T7C9L7H8F</string>
    <key>uploadSymbols</key>
    <true/>
    <key>signingStyle</key>
    <string>automatic</string>
</dict>
</plist>
PLIST

echo "==> Archiving..."
cd "$IOS_DIR"
xcodebuild \
  -project App.xcodeproj \
  -scheme App \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE_PATH" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$ASC_API_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
  archive 2>&1 | tee "$BUILD_LOG" | grep -E '^\*\*|error:|warning:' || true

if [ ! -d "$ARCHIVE_PATH" ]; then
  echo "Error: Archive failed. Full log: $BUILD_LOG" >&2
  tail -20 "$BUILD_LOG"
  exit 1
fi
echo "** ARCHIVE SUCCEEDED **"

# ── Export ──

echo "==> Exporting for TestFlight..."
xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$ASC_API_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
  2>&1 | tee -a "$BUILD_LOG" | grep -E '^\*\*|error:|Exported' || true

if [ ! -d "$EXPORT_PATH" ]; then
  echo "Error: Export failed. Full log: $BUILD_LOG" >&2
  tail -20 "$BUILD_LOG"
  exit 1
fi

# ── Upload to TestFlight ──

echo "==> Uploading to TestFlight..."
xcrun altool --upload-app \
  --type ios \
  --file "$EXPORT_PATH/App.ipa" \
  --apiKey "$ASC_KEY_ID" \
  --apiIssuer "$ASC_ISSUER_ID" 2>&1 | tail -5

echo ""
echo "Done! Build $NEW_BUILD ($ENV) uploaded to TestFlight."
