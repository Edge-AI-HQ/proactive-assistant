#!/usr/bin/env bash
set -euo pipefail

# Build, archive, and export the iOS app for TestFlight.
# After running this script, open Xcode Organizer (Window → Organizer)
# and click Distribute App → TestFlight Internal Testing → Distribute.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IOS_DIR="$PROJECT_ROOT/ios/App"
ARCHIVE_PATH="$IOS_DIR/build/App.xcarchive"
EXPORT_PATH="$IOS_DIR/build/export"
EXPORT_OPTIONS="$IOS_DIR/build/ExportOptions.plist"
ORGANIZER_DIR="$HOME/Library/Developer/Xcode/Archives/$(date +%Y-%m-%d)"

echo "==> Building frontend (Capacitor)..."
cd "$PROJECT_ROOT"
VITE_CAPACITOR=1 npx vite build

echo "==> Syncing iOS..."
npx cap sync ios

echo "==> Cleaning previous build..."
rm -rf "$ARCHIVE_PATH" "$EXPORT_PATH"

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
  archive \
  | tail -3

echo "==> Exporting for TestFlight..."
xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -allowProvisioningUpdates \
  | tail -3

echo "==> Copying archive to Xcode Organizer..."
mkdir -p "$ORGANIZER_DIR"
cp -R "$ARCHIVE_PATH" "$ORGANIZER_DIR/App $(date '+%Y-%m-%d %H.%M.%S').xcarchive"

echo ""
echo "Done! Open Xcode Organizer to upload to TestFlight:"
echo "  Xcode → Window → Organizer → select latest archive → Distribute App"
