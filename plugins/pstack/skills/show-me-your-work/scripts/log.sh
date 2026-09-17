#!/usr/bin/env bash
# Compatibility entry point for existing Bash callers.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$script_dir/log.mjs" "$@"
