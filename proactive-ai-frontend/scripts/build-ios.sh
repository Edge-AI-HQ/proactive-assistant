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
ARCHIVE_LOG="$IOS_DIR/build/archive.log"
EXPORT_LOG="$IOS_DIR/build/export.log"

# ── Error reporting helper ──

print_log_diagnostics() {
  local log_file="$1"
  local label="$2"
  {
    echo ""
    echo "--- $label log: last 40 lines (full: $log_file) ---"
    tail -40 "$log_file" 2>/dev/null || echo "(log file unavailable)"
    echo ""
    echo "--- $label log: lines matching /error|fatal|invalid|denied|cannot/i ---"
    grep -iE "error|fatal|invalid|denied|cannot" "$log_file" 2>/dev/null | tail -20 || echo "(no matches)"
    echo ""
  } >&2
}

# ── Environment selection ──

ENV="${1:-dev}"
case "$ENV" in
  dev)  ENV_FILE="$REPO_ROOT/pinai-agents/.env.dev" ;;
  prod) ENV_FILE="$REPO_ROOT/pinai-agents/.env.production" ;;
  *)    echo "Usage: $0 [dev|prod]" >&2; exit 1 ;;
esac

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found" >&2
  exit 1
fi

echo "==> Environment: $ENV"
echo "==> Reading VITE_* from $ENV_FILE"

get_env() { npx @dotenvx/dotenvx get "$1" -f "$ENV_FILE" 2>/dev/null; }

export VITE_PIN_API_URL
export VITE_SUPABASE_URL
export VITE_SUPABASE_PUBLISHABLE_KEY
VITE_PIN_API_URL="$(get_env VITE_PIN_API_URL)"
VITE_SUPABASE_URL="$(get_env VITE_SUPABASE_URL)"
VITE_SUPABASE_PUBLISHABLE_KEY="$(get_env VITE_SUPABASE_PUBLISHABLE_KEY)"

for var in VITE_PIN_API_URL VITE_SUPABASE_URL VITE_SUPABASE_PUBLISHABLE_KEY; do
  if [ -z "${!var}" ]; then
    echo "Error: $var is empty after reading from $ENV_FILE" >&2
    exit 1
  fi
done

echo "    VITE_PIN_API_URL=$VITE_PIN_API_URL"

# ── Validate ASC credentials ──

for var in ASC_API_KEY_PATH ASC_KEY_ID ASC_ISSUER_ID; do
  if [ -z "${!var:-}" ]; then
    echo "Error: $var is not set. Required for signing and upload." >&2
    exit 1
  fi
done

# ── Resolve build number ──
#
# CI:  CFBundleVersion = GITHUB_RUN_NUMBER + BUILD_NUMBER_OFFSET.
#      Monotonic per run, no commits required, no external API calls.
#      The offset keeps CI builds safely above pre-CI manual TestFlight
#      uploads (the highest manual build before CI takeover was 25 as of
#      2026-05-15). Once we cross over, only CI should upload — Apple
#      rejects duplicate or non-increasing CFBundleVersion values per
#      CFBundleShortVersionString.
#
# Local: fall back to agvtool's pbxproj bump. Will collide with CI builds
#        once CI starts uploading, so prefer the workflow_dispatch path
#        for any release-style upload.

cd "$IOS_DIR"
BUILD_NUMBER_OFFSET=100
if [ -n "${GITHUB_RUN_NUMBER:-}" ]; then
  NEW_BUILD=$((BUILD_NUMBER_OFFSET + GITHUB_RUN_NUMBER))
  echo "==> CI run #$GITHUB_RUN_NUMBER -> CFBundleVersion = $NEW_BUILD (offset $BUILD_NUMBER_OFFSET)"
  agvtool new-version -all "$NEW_BUILD" > /dev/null
else
  echo "==> Local build: bumping pbxproj build number..."
  agvtool next-version -all > /dev/null
  NEW_BUILD=$(agvtool what-version -terse)
  echo "    Build number: $NEW_BUILD"
fi
MARKETING_VERSION="$(agvtool what-marketing-version -terse1 2>/dev/null || echo "?")"

# ── Build frontend + Capacitor sync (shared with `make ios`) ──

bash "$SCRIPT_DIR/sync-ios.sh"

# ── Prep build dir ──

echo "==> Cleaning previous build..."
rm -rf "$ARCHIVE_PATH" "$EXPORT_PATH" "$ARCHIVE_LOG" "$EXPORT_LOG"
mkdir -p "$(dirname "$ARCHIVE_LOG")"

# ── ExportOptions.plist ──

echo "==> Writing ExportOptions.plist..."
cat > "$EXPORT_OPTIONS" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store</string>
    <key>teamID</key>
    <string>7T7C9L7H8F</string>
    <key>uploadSymbols</key>
    <true/>
    <key>signingStyle</key>
    <string>manual</string>
    <key>provisioningProfiles</key>
    <dict>
        <key>ai.pin.proactive</key>
        <string>PIN AI AppStore Distribution</string>
    </dict>
    <key>destination</key>
    <string>upload</string>
</dict>
</plist>
PLIST

# ── Archive ──

echo "==> [1/2] Archiving..."
if ! xcodebuild \
    -project App.xcodeproj \
    -scheme App \
    -configuration Release \
    -destination "generic/platform=iOS" \
    -archivePath "$ARCHIVE_PATH" \
    -allowProvisioningUpdates \
    -authenticationKeyPath "$ASC_API_KEY_PATH" \
    -authenticationKeyID "$ASC_KEY_ID" \
    -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
    archive 2>&1 | tee "$ARCHIVE_LOG"; then
  echo "" >&2
  echo "[FAILED] xcodebuild archive exited non-zero." >&2
  print_log_diagnostics "$ARCHIVE_LOG" "archive"
  exit 1
fi

if [ ! -d "$ARCHIVE_PATH" ]; then
  echo "" >&2
  echo "[FAILED] Archive exited 0 but $ARCHIVE_PATH was not produced." >&2
  print_log_diagnostics "$ARCHIVE_LOG" "archive"
  exit 1
fi

# ── Export + Upload ──

echo "==> [2/2] Exporting and uploading to TestFlight..."
if ! xcodebuild \
    -exportArchive \
    -archivePath "$ARCHIVE_PATH" \
    -exportPath "$EXPORT_PATH" \
    -exportOptionsPlist "$EXPORT_OPTIONS" \
    -allowProvisioningUpdates \
    -authenticationKeyPath "$ASC_API_KEY_PATH" \
    -authenticationKeyID "$ASC_KEY_ID" \
    -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
    2>&1 | tee "$EXPORT_LOG"; then
  echo "" >&2
  echo "[FAILED] xcodebuild exportArchive exited non-zero." >&2
  print_log_diagnostics "$EXPORT_LOG" "export"
  exit 1
fi

# xcodebuild can exit 0 even when exportArchive logged hard errors
# (e.g., entitlement / provisioning mismatch with -allowProvisioningUpdates).
# Treat `error: exportArchive` lines as fatal regardless of exit code.
if grep -qE "^error: exportArchive" "$EXPORT_LOG"; then
  echo "" >&2
  echo "[FAILED] exportArchive reported errors despite exit 0:" >&2
  grep -E "^error: exportArchive" "$EXPORT_LOG" >&2
  print_log_diagnostics "$EXPORT_LOG" "export"
  exit 1
fi

echo ""
echo "=========================================="
echo "  SUCCESS: uploaded to TestFlight"
echo "  Env:     $ENV"
echo "  Version: $MARKETING_VERSION ($NEW_BUILD)"
echo "  Bundle:  ai.pin.proactive"
echo "=========================================="
