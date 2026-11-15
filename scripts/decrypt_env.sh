#!/usr/bin/env bash
# decrypt_env.sh <dir> — atomically decrypt <dir>/.env.dev → <dir>/.env.
#
# Private key resolution (dotenvx checks both; env var wins):
#   - a DOTENV_PRIVATE_KEY_* environment variable (recommended — put it in your
#     shell, nothing to distribute or keep in the repo), OR
#   - a <dir>/.env.keys file (get from a teammate).
#
# dotenvx is a version-pinned root devDependency (see package.json), so we call
# it through `npx --no-install`: it resolves to the locally installed binary and
# never reaches the network or an interactive "Ok to proceed?" install prompt.
# A missing install fails fast with a clear "run npm install" message instead of
# hanging forever — the old bare `npx @dotenvx/dotenvx` resolved "latest" online
# and blocked on the hidden install prompt (swallowed by 2>/dev/null) whenever
# the local npx cache lagged behind a freshly published release.
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
err="$dir/.env.err"

# No encrypted file (e.g. a clone of the public mirror): use a hand-written .env.
if [ ! -f "$src" ]; then
  [ -s "$dst" ] && exit 0
  echo "decrypt_env: neither $src nor $dst found." >&2
  echo "  Copy $dir/.env.example to $dst and fill in your own values." >&2
  exit 1
fi

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

# dotenvx must be installed locally (root devDependency). Fail fast with a clear
# message instead of letting `npx --no-install` emit its cryptic error below.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ ! -x "$root/node_modules/.bin/dotenvx" ]; then
  echo "decrypt_env: @dotenvx/dotenvx is not installed — run: npm install" >&2
  exit 1
fi

echo "Decrypting $src -> $dst"
# --overload decrypts to the FILE's values, overriding any same-named variable
# already in the caller's shell. Without it, `dotenvx get` uses env-var-wins
# precedence, so a var exported in the shell silently overwrites the real
# decrypted value in .env — e.g. Claude Code injects an empty ANTHROPIC_API_KEY,
# which would otherwise blank out the key here.
#
# dotenvx logs to stderr (captured to $err) and emits the JSON on stdout. Print
# the captured stderr only on failure, so a real decrypt error is surfaced
# instead of being silently swallowed by a blanket 2>/dev/null.
if ! npx --no-install @dotenvx/dotenvx get -f "$src" --format json --overload 2>"$err" \
  | python3 -c 'import json,sys;[print(k+"="+chr(39)+str(v)+chr(39)) for k,v in json.load(sys.stdin).items() if not k.startswith("DOTENV_PUBLIC_KEY")]' \
  > "$tmp"; then
  cat "$err" >&2
  rm -f "$tmp" "$err"
  echo "decrypt_env: failed to decrypt $src (check key / dotenvx — see error above)." >&2
  exit 1
fi
rm -f "$err"

if [ -s "$tmp" ]; then
  mv "$tmp" "$dst"
else
  rm -f "$tmp"
  echo "decrypt_env: decrypting $src produced no output (check key / dotenvx)." >&2
  exit 1
fi
