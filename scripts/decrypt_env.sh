#!/usr/bin/env bash
# decrypt_env.sh <dir> — atomically decrypt <dir>/.env.dev → <dir>/.env.
#
# Private key resolution (dotenvx checks both; env var wins):
#   - a DOTENV_PRIVATE_KEY_* environment variable (recommended — put it in your
#     shell, nothing to distribute or keep in the repo), OR
#   - a <dir>/.env.keys file (get from a teammate).
#
# Skips when <dir>/.env is present, non-empty and newer than .env.dev. Decrypt
# writes to a temp file and only moves it into place when non-empty, so a
# failed or interrupted decrypt never leaves a 0-byte .env that the freshness
# check would then skip forever (recover with `make env-local`).
set -euo pipefail

dir="${1:?usage: decrypt_env.sh <dir>}"
src="$dir/.env.dev"
dst="$dir/.env"
tmp="$dir/.env.tmp"

[ -f "$src" ] || { echo "decrypt_env: $src not found" >&2; exit 1; }

# Up to date already? (.env exists, non-empty, at least as new as .env.dev)
if [ -s "$dst" ] && [ ! "$src" -nt "$dst" ]; then
  exit 0
fi

# Need a decryption key: an env var or a .env.keys file.
if ! printenv | grep -q '^DOTENV_PRIVATE_KEY' && [ ! -f "$dir/.env.keys" ]; then
  echo "decrypt_env: no key for $src — set DOTENV_PRIVATE_KEY_* in your shell," >&2
  echo "  or put $dir/.env.keys in place (get from a teammate)." >&2
  exit 1
fi

echo "Decrypting $src -> $dst"
# --overload decrypts to the FILE's values, overriding any same-named variable
# already in the caller's shell. Without it, `dotenvx get` uses env-var-wins
# precedence, so a var exported in the shell silently overwrites the real
# decrypted value in .env — e.g. Claude Code injects an empty ANTHROPIC_API_KEY,
# which would otherwise blank out the key here.
npx @dotenvx/dotenvx get -f "$src" --format json --overload 2>/dev/null \
  | python3 -c 'import json,sys;[print(k+"="+chr(39)+str(v)+chr(39)) for k,v in json.load(sys.stdin).items() if not k.startswith("DOTENV_PUBLIC_KEY")]' \
  > "$tmp"

if [ -s "$tmp" ]; then
  mv "$tmp" "$dst"
else
  rm -f "$tmp"
  echo "decrypt_env: decrypting $src produced no output (check key / dotenvx)." >&2
  exit 1
fi
