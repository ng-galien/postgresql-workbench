#!/usr/bin/env bash

set -uo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <npm-script> [npm-script-arguments...]" >&2
  exit 2
fi

script_name=$1
shift
extension_root=$(cd "$(dirname "$0")/../../vscode-extension" && pwd)
results_dir="$extension_root/test-results"
screen_snapshot="$results_dir/runner-screen-latest.png"
export PGWB_ACCEPTANCE_VSCODE_VERSION="${PGWB_ACCEPTANCE_VSCODE_VERSION:-1.109.0}"
export PGWB_PLAYWRIGHT_MINIMAL_DIAGNOSTICS="${PGWB_PLAYWRIGHT_MINIMAL_DIAGNOSTICS:-1}"
mkdir -p "$results_dir"

echo "Playwright runtime: Node $(node --version), VS Code $PGWB_ACCEPTANCE_VSCODE_VERSION"

(
  cd "$extension_root"
  if [[ $# -eq 0 ]]; then
    npm run "$script_name"
  else
    npm run "$script_name" -- "$@"
  fi
) &
test_pid=$!

(
  while kill -0 "$test_pid" 2>/dev/null; do
    sleep 5
    scrot -o "$screen_snapshot" 2>/dev/null || true
  done
) &
snapshot_pid=$!

wait "$test_pid"
status=$?
kill "$snapshot_pid" 2>/dev/null || true
wait "$snapshot_pid" 2>/dev/null || true

if [[ $status -eq 0 ]]; then
  rm -f "$screen_snapshot"
else
  if [[ -f $screen_snapshot ]]; then
    cp "$screen_snapshot" "$results_dir/runner-screen-final.png"
  else
    scrot -o "$results_dir/runner-screen-final.png" 2>/dev/null || true
  fi
  if [[ -f /tmp/postgresql-workbench.log ]]; then
    cp /tmp/postgresql-workbench.log "$results_dir/dap-server.log"
  fi
fi

exit "$status"
