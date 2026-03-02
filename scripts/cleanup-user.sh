#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/cleanup-user.sh <telegram_user_id>
# Destroys the user's Fly machine and deletes all DB records (cascade).
# Requires: psql, flyctl
# 用法 DATABASE_URL="postgresql://postgres:REDACTED@db.ighqvjvsjpmbjdjfahvl.supabase.co:5432/postgres" \
  ./scripts/cleanup-user.sh 6142814327

TELEGRAM_USER_ID="${1:?Usage: $0 <telegram_user_id>}"
FLY_APP="${FLY_APP:-pinclaw-api-dev}"
DATABASE_URL="${DATABASE_URL:?Set DATABASE_URL (Supabase postgres connection string)}"

echo "🔍 Looking up telegram_user_id=${TELEGRAM_USER_ID} ..."

ROW=$(psql "$DATABASE_URL" -t -A -F'|' -c "
  SELECT u.id, u.telegram_username,
    r.runtime_ref, r.container_name, r.status
  FROM users u
  LEFT JOIN assistants a ON a.owner_user_id = u.id
  LEFT JOIN runtime_instances r ON (r.assistant_id = a.id OR r.owner_user_id = u.id)
  WHERE u.telegram_user_id = ${TELEGRAM_USER_ID}
  LIMIT 1;
")

if [ -z "$ROW" ]; then
  echo "❌ User not found"
  exit 1
fi

IFS='|' read -r USER_ID TG_USERNAME RUNTIME_REF CONTAINER_NAME RUNTIME_STATUS <<< "$ROW"

echo ""
echo "  user_id:        ${USER_ID}"
echo "  username:       ${TG_USERNAME}"
echo "  container:      ${CONTAINER_NAME:-none}"
echo "  runtime_ref:    ${RUNTIME_REF:-none}"
echo "  status:         ${RUNTIME_STATUS:-none}"
echo ""

read -rp "⚠️  Destroy machine + delete all DB records? [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[yY]$ ]]; then
  echo "Aborted."
  exit 0
fi

# Extract Fly machine ID from runtime_ref (format: fly:<machineId>|<ipv6>)
if [ -n "$RUNTIME_REF" ]; then
  MACHINE_ID=$(echo "$RUNTIME_REF" | sed -n 's/^fly:\([^|]*\).*/\1/p')
  if [ -n "$MACHINE_ID" ]; then
    echo "🗑️  Destroying Fly machine ${MACHINE_ID} ..."
    if flyctl machines destroy "$MACHINE_ID" -a "$FLY_APP" --force 2>&1; then
      echo "   ✅ Machine destroyed"
    else
      echo "   ⚠️  Machine destroy failed (may already be gone)"
    fi
  fi
fi

echo "🗑️  Deleting DB records (user_id=${USER_ID}, cascade) ..."
psql "$DATABASE_URL" -c "DELETE FROM users WHERE id = ${USER_ID};"

echo ""
echo "✅ Done. telegram_user_id=${TELEGRAM_USER_ID} fully cleaned up."
