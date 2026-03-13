#!/usr/bin/env bash
set -euo pipefail

# Build and push the OpenClaw image to Fly registry without deploying an app.
#
# Usage:
#   ./scripts/build-openclaw-image.sh dev
#   ./scripts/build-openclaw-image.sh prod
#   IMAGE_LABEL=my-openclaw-build ./scripts/build-openclaw-image.sh prod

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TARGET_ENV="${1:-prod}"

case "${TARGET_ENV}" in
  dev)
    FLY_APP="${FLY_APP:-pinclaw-assistant-dev}"
    SECRET_APP="${SECRET_APP:-pinclaw-api-dev}"
    ;;
  prod)
    FLY_APP="${FLY_APP:-pinclaw-assistant-prod}"
    SECRET_APP="${SECRET_APP:-pinclaw-api-prod}"
    ;;
  *)
    echo "Usage: $0 <dev|prod>"
    exit 1
    ;;
esac

DOCKERFILE_PATH="${DOCKERFILE_PATH:-pinai-openclaw/image/Dockerfile}"
IMAGE_LABEL="${IMAGE_LABEL:-openclaw-$(date +%Y%m%d-%H%M%S)}"
BUILD_CONFIG_PATH="${BUILD_CONFIG_PATH:-${REPO_ROOT}/.fly-openclaw-build.${FLY_APP}.toml}"

cleanup() {
  rm -f "${BUILD_CONFIG_PATH}"
}

trap cleanup EXIT

if ! command -v flyctl >/dev/null 2>&1; then
  echo "flyctl not found"
  exit 1
fi

if [ ! -f "${REPO_ROOT}/${DOCKERFILE_PATH}" ]; then
  echo "Dockerfile not found: ${REPO_ROOT}/${DOCKERFILE_PATH}"
  exit 1
fi

cat > "${BUILD_CONFIG_PATH}" <<EOF
app = "${FLY_APP}"

[build]
  dockerfile = "${DOCKERFILE_PATH}"
EOF

echo "Building OpenClaw image"
echo "  env:        ${TARGET_ENV}"
echo "  app:        ${FLY_APP}"
echo "  secret app: ${SECRET_APP}"
echo "  dockerfile: ${DOCKERFILE_PATH}"
echo "  label:      ${IMAGE_LABEL}"
echo

BUILD_OUTPUT_FILE="$(mktemp)"

(
  cd "${REPO_ROOT}"
  env -u all_proxy -u http_proxy -u https_proxy -u ALL_PROXY -u HTTP_PROXY -u HTTPS_PROXY \
    flyctl deploy . \
      --config "${BUILD_CONFIG_PATH}" \
      --build-only \
      --push \
      --image-label "${IMAGE_LABEL}" \
      --remote-only \
      --depot=false \
      --yes
) 2>&1 | tee "${BUILD_OUTPUT_FILE}"

if command -v rg >/dev/null 2>&1; then
  DIGEST_REF="$(
    rg -o "registry\\.fly\\.io/${FLY_APP}@sha256:[0-9a-f]{64}" "${BUILD_OUTPUT_FILE}" \
      | tail -n 1
  )"
else
  DIGEST_REF="$(
    grep -Eo "registry\\.fly\\.io/${FLY_APP}@sha256:[0-9a-f]{64}" "${BUILD_OUTPUT_FILE}" \
      | tail -n 1
  )"
fi

if [ -z "${DIGEST_REF}" ]; then
  echo
  echo "Build completed, but digest was not found in output."
  echo "Inspect logs above and search for sha256 manually."
  exit 1
fi

echo
echo "OpenClaw image digest:"
echo "${DIGEST_REF}"
echo
echo "Set OPENCLAW_IMAGE with:"
echo "flyctl secrets set \\"
echo "  OPENCLAW_IMAGE=${DIGEST_REF} \\"
echo "  -a ${SECRET_APP}"
