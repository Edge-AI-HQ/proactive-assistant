#!/usr/bin/env bash
# sync-ios.sh — shared build + Capacitor sync for iOS.
#
# Used by both `make ios` (local Xcode dev) and `scripts/build-ios.sh` (CI
# TestFlight). Anything that needs to happen *before* xcodebuild / Xcode
# opens lives here.
#
# Required env:
#   VITE_PIN_API_URL — backend API URL to bake into the JS bundle.
#
# Optional env (passed through to vite, otherwise read from .env at build time):
#   VITE_SUPABASE_URL
#   VITE_SUPABASE_PUBLISHABLE_KEY
#
# Does NOT sign, archive, or open Xcode. Callers do that.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$FRONTEND_DIR/.." && pwd)"
IOS_DIR="$FRONTEND_DIR/ios/App"

if [ -z "${VITE_PIN_API_URL:-}" ]; then
  echo "Error: VITE_PIN_API_URL is required" >&2
  exit 1
fi

echo "==> Building frontend with VITE_PIN_API_URL=$VITE_PIN_API_URL"
cd "$FRONTEND_DIR"
# OAuth scheme must equal the bundle id the native app is built with, or the
# deep-link callback opens the wrong app. CI (build-ios.sh) always passes it
# explicitly; the local-Xcode default below must stay in sync with the
# checked-in PRODUCT_BUNDLE_IDENTIFIER in App.xcodeproj/project.pbxproj.
VITE_CAPACITOR=1 \
  VITE_PIN_API_URL="$VITE_PIN_API_URL" \
  VITE_API_BASE_URL="$VITE_PIN_API_URL" \
  VITE_OAUTH_SCHEME="${VITE_OAUTH_SCHEME:-ai.pin.proactive.development}" \
  npx vite build

echo "==> Syncing iOS..."
npx cap sync ios

echo "==> Fixing deployment target..."
node "$REPO_ROOT/capacitor-plugins/ambient-ai/scripts/fix-deployment-target.mjs" \
  ios/App/App.xcodeproj/project.pbxproj \
  --package-swift ios/App/CapApp-SPM/Package.swift

echo "==> Verifying VITE_PIN_API_URL embedded in built JS..."
if ! grep -q "$VITE_PIN_API_URL" "$IOS_DIR"/App/public/assets/index-*.js 2>/dev/null; then
  echo "Error: VITE_PIN_API_URL not found in built JS — aborting" >&2
  exit 1
fi
echo "    OK"
