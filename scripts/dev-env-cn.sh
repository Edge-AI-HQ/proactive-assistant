#!/usr/bin/env bash

if [ -n "${BASH_SOURCE:-}" ]; then
  _pinai_dev_env_script="${BASH_SOURCE[0]}"
else
  _pinai_dev_env_script="$0"
fi
_pinai_dev_env_dir="$(cd "$(dirname "$_pinai_dev_env_script")" && pwd)"
. "$_pinai_dev_env_dir/_dev_env.sh"
pinai_switch_dev_region cn
unset _pinai_dev_env_script _pinai_dev_env_dir
