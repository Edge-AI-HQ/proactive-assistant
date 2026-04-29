#!/usr/bin/env bash
set -euo pipefail

# Usage: DATABASE_URL="..." ./scripts/cleanup-user.sh [-y] <supabase_user_id>
# Destroys the user's Fly machine and deletes all DB records (cascade).
# Requires: psql, flyctl

AUTO_YES=false
while getopts "y" opt; do
  case "$opt" in y) AUTO_YES=true ;; *) ;; esac
done
shift $((OPTIND - 1))

SUPABASE_USER_ID="${1:?Usage: $0 [-y] <supabase_user_id>}"
FLY_APP="${FLY_APP:-proactive-ai-assistant-dev}"
DATABASE_URL="${DATABASE_URL:?Set DATABASE_URL (Supabase postgres connection string)}"

echo "🔍 Looking up supabase_user_id=${SUPABASE_USER_ID} ..."

ROW=$(psql "$DATABASE_URL" -t -A -F'|' -c "
  SELECT u.id, u.email,
    r.runtime_ref, r.container_name, r.status
  FROM users u
  LEFT JOIN runtime_instances r ON r.owner_user_id = u.id AND r.scope = 'user'
  WHERE u.supabase_user_id = '${SUPABASE_USER_ID}'::uuid
  LIMIT 1;
")

if [ -z "$ROW" ]; then
  echo "❌ User not found"
  exit 1
fi

IFS='|' read -r USER_ID EMAIL RUNTIME_REF CONTAINER_NAME RUNTIME_STATUS <<< "$ROW"

echo ""
echo "  user_id:        ${USER_ID}"
echo "  email:          ${EMAIL}"
echo "  container:      ${CONTAINER_NAME:-none}"
echo "  runtime_ref:    ${RUNTIME_REF:-none}"
echo "  status:         ${RUNTIME_STATUS:-none}"
echo ""

if [ "$AUTO_YES" != true ]; then
  read -rp "⚠️  Destroy machine + delete all DB records? [y/N] " CONFIRM
  if [[ ! "$CONFIRM" =~ ^[yY]$ ]]; then
    echo "Aborted."
    exit 0
  fi
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
echo "✅ Done. supabase_user_id=${SUPABASE_USER_ID} fully cleaned up."
