#!/usr/bin/env bash
set -euo pipefail

# Build a signed release APK for internal distribution.
#
# Signing options (pick one):
#   A) keystore.properties file in android/ directory:
#        storeFile=../release.keystore
#        storePassword=changeit
#        keyAlias=pin-ai
#        keyPassword=changeit
#
#   B) Environment variables:
#        ANDROID_KEYSTORE_PATH  — path to .keystore file
#        ANDROID_KEYSTORE_PASSWORD
#        ANDROID_KEY_ALIAS
#        ANDROID_KEY_PASSWORD
#
#   If neither is set, the APK is signed with the debug keystore (fine for
#   internal testing, but not suitable for Play Store).
#
# Optional environment variables:
#   ANDROID_VERSION_CODE  — integer, must increment for each Play Store upload (default: 1)
#   ANDROID_VERSION_NAME  — human-readable version string (default: "1.0")
#   BUILD_TYPE            — "apk" (default) or "aab" (Android App Bundle)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ANDROID_DIR="$PROJECT_ROOT/android"
BUILD_TYPE="${BUILD_TYPE:-apk}"

# ---------- 1. Frontend build ----------
echo "==> Building frontend (Capacitor)..."
cd "$PROJECT_ROOT"
VITE_CAPACITOR=1 npx vite build

# ---------- 2. Capacitor sync ----------
echo "==> Syncing Android..."
npx cap sync android

# ---------- 3. Gradle build ----------
cd "$ANDROID_DIR"

# Ensure gradlew is executable
chmod +x ./gradlew

if [ "$BUILD_TYPE" = "aab" ]; then
    GRADLE_TASK="bundleRelease"
    echo "==> Building release AAB..."
else
    GRADLE_TASK="assembleRelease"
    echo "==> Building release APK..."
fi

./gradlew "$GRADLE_TASK" --no-daemon --warning-mode all

# ---------- 4. Locate output ----------
if [ "$BUILD_TYPE" = "aab" ]; then
    OUTPUT=$(find "$ANDROID_DIR/app/build/outputs/bundle/release" -name "*.aab" -print -quit 2>/dev/null || true)
else
    OUTPUT=$(find "$ANDROID_DIR/app/build/outputs/apk/release" -name "*.apk" -print -quit 2>/dev/null || true)
fi

if [ -z "$OUTPUT" ]; then
    echo "ERROR: Build output not found." >&2
    exit 1
fi

# ---------- 5. Copy to project root for easy access ----------
BASENAME="pin-ai-$(date +%Y%m%d-%H%M%S).${BUILD_TYPE}"
DEST="$PROJECT_ROOT/build/$BASENAME"
mkdir -p "$PROJECT_ROOT/build"
cp "$OUTPUT" "$DEST"

echo ""
echo "==> Build complete!"
echo "    Output: $DEST"
echo "    Size:   $(du -h "$DEST" | cut -f1)"

# Check signing status
if [ "$BUILD_TYPE" = "apk" ]; then
    if command -v apksigner &>/dev/null; then
        if apksigner verify "$DEST" 2>/dev/null; then
            echo "    Signed:  yes"
        else
            echo "    Signed:  debug key (install with 'adb install $DEST')"
        fi
    else
        echo "    Tip:     run 'apksigner verify $DEST' to check signing status"
    fi
fi
