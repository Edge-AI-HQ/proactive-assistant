#!/usr/bin/env bash
set -euo pipefail

# Build and push the OpenClaw image to the shared Fly registry.
# One registry (proactive-ai-openclaw), all environments use the same digest.
#
# Usage:
#   ./scripts/build-openclaw-image.sh
#   IMAGE_LABEL=my-build ./scripts/build-openclaw-image.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

FLY_APP="${FLY_APP:-proactive-ai-openclaw}"
FLY_CONFIG_PATH="${FLY_CONFIG_PATH:-fly.openclaw.toml}"
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
echo "  registry:   ${FLY_APP}"
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

# Try multiple digest formats
if command -v rg >/dev/null 2>&1; then
  DIGEST_REF="$(rg -o "registry\\.fly\\.io/${FLY_APP}@sha256:[0-9a-f]{64}" "${BUILD_OUTPUT_FILE}" | tail -n 1 || true)"
  if [ -z "${DIGEST_REF}" ]; then
    SHA256_ONLY="$(rg -o "digest: sha256:[0-9a-f]{64}" "${BUILD_OUTPUT_FILE}" | rg -o "sha256:[0-9a-f]{64}" | tail -n 1 || true)"
    if [ -n "${SHA256_ONLY}" ]; then
      DIGEST_REF="registry.fly.io/${FLY_APP}@${SHA256_ONLY}"
    fi
  fi
  if [ -z "${DIGEST_REF}" ]; then
    SHA256_ONLY="$(rg -o "sha256:[0-9a-f]{64}" "${BUILD_OUTPUT_FILE}" | tail -n 1 || true)"
    if [ -n "${SHA256_ONLY}" ]; then
      DIGEST_REF="registry.fly.io/${FLY_APP}@${SHA256_ONLY}"
    fi
  fi
else
  DIGEST_REF="$(grep -Eo "registry\\.fly\\.io/${FLY_APP}@sha256:[0-9a-f]{64}" "${BUILD_OUTPUT_FILE}" | tail -n 1 || true)"
  if [ -z "${DIGEST_REF}" ]; then
    SHA256_ONLY="$(grep -Eo "digest: sha256:[0-9a-f]{64}" "${BUILD_OUTPUT_FILE}" | grep -Eo "sha256:[0-9a-f]{64}" | tail -n 1 || true)"
    if [ -n "${SHA256_ONLY}" ]; then
      DIGEST_REF="registry.fly.io/${FLY_APP}@${SHA256_ONLY}"
    fi
  fi
  if [ -z "${DIGEST_REF}" ]; then
    SHA256_ONLY="$(grep -Eo "sha256:[0-9a-f]{64}" "${BUILD_OUTPUT_FILE}" | tail -n 1 || true)"
    if [ -n "${SHA256_ONLY}" ]; then
      DIGEST_REF="registry.fly.io/${FLY_APP}@${SHA256_ONLY}"
    fi
  fi
fi

if [ -z "${DIGEST_REF}" ]; then
  echo
  echo "Build completed, but digest was not found in output."
  echo
  echo "Debug: Searching build output for 'sha256'..."
  if command -v rg >/dev/null 2>&1; then
    rg "sha256" "${BUILD_OUTPUT_FILE}" || echo "No sha256 found in output"
  else
    grep "sha256" "${BUILD_OUTPUT_FILE}" || echo "No sha256 found in output"
  fi
  echo
  echo "Full build output saved to: ${BUILD_OUTPUT_FILE}"
  trap - EXIT
  exit 1
fi

echo
echo "OpenClaw image digest:"
echo
echo "  ${DIGEST_REF}"
echo
echo "Update OPENCLAW_IMAGE for each environment:"
echo
echo "  # dev"
echo "  npx @dotenvx/dotenvx set OPENCLAW_IMAGE \"${DIGEST_REF}\" -f apis/.env.dev"
echo
echo "  # production (after dev verification)"
echo "  npx @dotenvx/dotenvx set OPENCLAW_IMAGE \"${DIGEST_REF}\" -f apis/.env.production"
echo
