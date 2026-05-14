#!/usr/bin/env bash
# check-ios-signing.sh — guard pbxproj from accidentally committing a personal
# Apple Developer team ID.
#
# pbxproj is shared across the team, but Xcode UI rewrites DEVELOPMENT_TEAM
# whenever you switch teams in Signing & Capabilities. If a developer commits
# that change, the repo's canonical team drifts and (a) other developers'
# local builds break, (b) CI's signing-by-name still works (ASC API key
# overrides), masking the problem until someone tries Xcode locally.
#
# This check pins DEVELOPMENT_TEAM to the canonical team (matches CI
# ExportOptions.plist + the AppStore Distribution profile in
# PROVISIONING_PROFILE_BASE64). Developers who need a different team
# locally must use a gitignored override (see ios/README.md).
#
# Run: bash proactive-ai-frontend/scripts/check-ios-signing.sh
# CI:  hooked into .github/workflows/ci.yml frontend-check job.

set -euo pipefail

EXPECTED_TEAM="7T7C9L7H8F"
PBXPROJ="proactive-ai-frontend/ios/App/App.xcodeproj/project.pbxproj"

cd "$(git rev-parse --show-toplevel)"

if [ ! -f "$PBXPROJ" ]; then
  echo "Skipping ios signing check: $PBXPROJ not found"
  exit 0
fi

teams=$(grep -oE "DEVELOPMENT_TEAM = [A-Z0-9]+;" "$PBXPROJ" | sort -u || true)
if [ -z "$teams" ]; then
  exit 0
fi

bad=0
while IFS= read -r line; do
  if [ "$line" != "DEVELOPMENT_TEAM = $EXPECTED_TEAM;" ]; then
    echo "❌ $PBXPROJ has '$line' (expected 'DEVELOPMENT_TEAM = $EXPECTED_TEAM;')"
    bad=1
  fi
done <<< "$teams"

if [ "$bad" -ne 0 ]; then
  cat >&2 <<EOF

iOS signing check failed.

The canonical DEVELOPMENT_TEAM is $EXPECTED_TEAM. This matches CI's
ExportOptions.plist and the AppStore Distribution profile, and is what
all other developers' machines expect.

If Xcode rewrote pbxproj to your personal team, revert just that change:
  git checkout -- $PBXPROJ

If you genuinely need a different team for local builds, do NOT edit
pbxproj. See proactive-ai-frontend/ios/README.md for how to use a
gitignored Local.xcconfig override instead.
EOF
  exit 1
fi

echo "iOS signing check: DEVELOPMENT_TEAM = $EXPECTED_TEAM ✓"
