#!/usr/bin/env bash
# Build + register the Pin AI Daytona snapshot.
#
# Usage:
#   bash infra/daytona/build_snapshot.sh 0.1.0
#   bash infra/daytona/build_snapshot.sh                      # uses pyproject.toml version
#
# Requires:
#   * DAYTONA_API_KEY in env (same key the chat process uses).
#   * `daytona` CLI on PATH (https://www.daytona.io/docs/getting-started/installation).
#
# Convention: snapshot name = pinai-sandbox:<version>. The chat process's
# python_exec pins the version it consumes — bumping the snapshot here
# without flipping the consumer means nothing changes for live runs.

set -euo pipefail

cd "$(dirname "$0")/../.."

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(grep -E '^version\s*=' packages/pinai_sdk/pyproject.toml | head -1 | sed -E 's/.*"(.+)".*/\1/')"
fi
if [ -z "$VERSION" ]; then
  echo "FATAL: could not derive version" >&2
  exit 1
fi

NAME="pinai-sandbox:${VERSION}"
echo "→ building Daytona snapshot ${NAME} from infra/daytona/Dockerfile"

if [ -z "${DAYTONA_API_KEY:-}" ]; then
  echo "FATAL: DAYTONA_API_KEY not set" >&2
  exit 1
fi

# Daytona CLI uploads dockerfile + context to its build service.
# `--context .` so COPY packages/pinai_sdk/ resolves.
daytona snapshot create "${NAME}" \
  --dockerfile infra/daytona/Dockerfile \
  --context . \
  --cpu 2 --memory 4 --disk 8

echo "→ snapshot ${NAME} registered"
echo "→ to use it, point chat/tools/sandbox.py to snapshot=${NAME}"
