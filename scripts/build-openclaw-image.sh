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
    FLY_APP="${FLY_APP:-pinclaw-openclaw-dev}"
    SECRET_APP="${SECRET_APP:-pinclaw-api-dev}"
    FLY_CONFIG_PATH="${FLY_CONFIG_PATH:-pinai-openclaw/fly.dev.toml}"
    ;;
  prod)
    FLY_APP="${FLY_APP:-pinclaw-openclaw-prod}"
    SECRET_APP="${SECRET_APP:-pinclaw-api-prod}"
    FLY_CONFIG_PATH="${FLY_CONFIG_PATH:-pinai-openclaw/fly.prod.toml}"
    ;;
  *)
    echo "Usage: $0 <dev|prod>"
    exit 1
    ;;
esac

IMAGE_LABEL="${IMAGE_LABEL:-openclaw-$(date +%Y%m%d-%H%M%S)}"
BUILD_OUTPUT_FILE="$(mktemp)"

cleanup() {
  rm -f "${BUILD_OUTPUT_FILE}"
}

trap cleanup EXIT

if ! command -v flyctl >/dev/null 2>&1; then
  echo "flyctl not found"
  exit 1
fi

if [ ! -f "${REPO_ROOT}/${FLY_CONFIG_PATH}" ]; then
  echo "Fly config not found: ${REPO_ROOT}/${FLY_CONFIG_PATH}"
  exit 1
fi

echo "Building OpenClaw image"
echo "  env:        ${TARGET_ENV}"
echo "  app:        ${FLY_APP}"
echo "  secret app: ${SECRET_APP}"
echo "  config:     ${FLY_CONFIG_PATH}"
echo "  label:      ${IMAGE_LABEL}"
echo

(
  cd "${REPO_ROOT}"
  env -u all_proxy -u http_proxy -u https_proxy -u ALL_PROXY -u HTTP_PROXY -u HTTPS_PROXY \
    flyctl deploy . \
      --config "${FLY_CONFIG_PATH}" \
      --build-only \
      --push \
      --image-label "${IMAGE_LABEL}" \
      --remote-only \
      --depot=false \
      --yes
) 2>&1 | tee "${BUILD_OUTPUT_FILE}"

echo
echo "Extracting digest from build output..."
echo

# 尝试多种可能的 digest 格式
if command -v rg >/dev/null 2>&1; then
  # 尝试完整格式: registry.fly.io/app@sha256:...
  DIGEST_REF="$(rg -o "registry\\.fly\\.io/${FLY_APP}@sha256:[0-9a-f]{64}" "${BUILD_OUTPUT_FILE}" | tail -n 1 || true)"
  
  # 如果没找到,尝试匹配 "digest: sha256:..." 格式
  if [ -z "${DIGEST_REF}" ]; then
    SHA256_ONLY="$(rg -o "digest: sha256:[0-9a-f]{64}" "${BUILD_OUTPUT_FILE}" | rg -o "sha256:[0-9a-f]{64}" | tail -n 1 || true)"
    if [ -n "${SHA256_ONLY}" ]; then
      DIGEST_REF="registry.fly.io/${FLY_APP}@${SHA256_ONLY}"
    fi
  fi
  
  # 最后尝试只匹配任意 sha256:...
  if [ -z "${DIGEST_REF}" ]; then
    SHA256_ONLY="$(rg -o "sha256:[0-9a-f]{64}" "${BUILD_OUTPUT_FILE}" | tail -n 1 || true)"
    if [ -n "${SHA256_ONLY}" ]; then
      DIGEST_REF="registry.fly.io/${FLY_APP}@${SHA256_ONLY}"
    fi
  fi
else
  # 尝试完整格式
  DIGEST_REF="$(grep -Eo "registry\\.fly\\.io/${FLY_APP}@sha256:[0-9a-f]{64}" "${BUILD_OUTPUT_FILE}" | tail -n 1 || true)"
  
  # 如果没找到,尝试匹配 "digest: sha256:..." 格式
  if [ -z "${DIGEST_REF}" ]; then
    SHA256_ONLY="$(grep -Eo "digest: sha256:[0-9a-f]{64}" "${BUILD_OUTPUT_FILE}" | grep -Eo "sha256:[0-9a-f]{64}" | tail -n 1 || true)"
    if [ -n "${SHA256_ONLY}" ]; then
      DIGEST_REF="registry.fly.io/${FLY_APP}@${SHA256_ONLY}"
    fi
  fi
  
  # 最后尝试只匹配任意 sha256:...
  if [ -z "${DIGEST_REF}" ]; then
    SHA256_ONLY="$(grep -Eo "sha256:[0-9a-f]{64}" "${BUILD_OUTPUT_FILE}" | tail -n 1 || true)"
    if [ -n "${SHA256_ONLY}" ]; then
      DIGEST_REF="registry.fly.io/${FLY_APP}@${SHA256_ONLY}"
    fi
  fi
fi

if [ -z "${DIGEST_REF}" ]; then
  echo
  echo "❌ Build completed, but digest was not found in output."
  echo
  echo "Debug: Searching build output for 'sha256'..."
  if command -v rg >/dev/null 2>&1; then
    rg "sha256" "${BUILD_OUTPUT_FILE}" || echo "No sha256 found in output"
  else
    grep "sha256" "${BUILD_OUTPUT_FILE}" || echo "No sha256 found in output"
  fi
  echo
  echo "Full build output saved to: ${BUILD_OUTPUT_FILE}"
  echo "Please inspect the file manually."
  
  # 不自动删除,方便调试
  trap - EXIT
  exit 1
fi

echo
echo "✅ OpenClaw image digest:"
echo
echo "  ${DIGEST_REF}"
echo
echo "Set OPENCLAW_IMAGE with:"
echo
echo "  flyctl secrets set OPENCLAW_IMAGE=\"${DIGEST_REF}\" -a ${SECRET_APP}"
echo
