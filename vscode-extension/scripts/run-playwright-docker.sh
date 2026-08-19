#!/usr/bin/env bash

set -euo pipefail

docker_desktop_bin=/Applications/Docker.app/Contents/Resources/bin
if [[ $(uname -s) == "Darwin" && -d $docker_desktop_bin ]]; then
  export PATH="$docker_desktop_bin:$PATH"
fi

extension_root=$(cd "$(dirname "$0")/.." && pwd)
compose_file="$extension_root/tests/acceptance/docker-compose.playwright-ci.yml"
requested_lane=${1:-all}
if [[ $# -gt 0 ]]; then
  shift
fi

usage() {
  cat >&2 <<'EOF'
Usage: run-playwright-docker.sh [all|bootstrap|core|schema-sync] [Playwright arguments...]

Examples:
  run-playwright-docker.sh
  run-playwright-docker.sh core --grep "SQL authoring"
  run-playwright-docker.sh schema-sync
EOF
}

case "$requested_lane" in
  all|test:acceptance)
    lanes=(bootstrap core schema-sync)
    ;;
  bootstrap|test:bootstrap)
    lanes=(bootstrap)
    ;;
  core|test:acceptance:core)
    lanes=(core)
    ;;
  schema-sync|test:acceptance:schema-sync)
    lanes=(schema-sync)
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage
    exit 2
    ;;
esac

if [[ ${#lanes[@]} -gt 1 && $# -gt 0 ]]; then
  echo "Playwright filters require an explicit lane so that they cannot silently skip another lane." >&2
  usage
  exit 2
fi

raw_run_id=${PGWB_PLAYWRIGHT_RUN_ID:-"$(date -u +%Y%m%dT%H%M%SZ)-$$"}
run_id=$(printf '%s' "$raw_run_id" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9-' '-' | cut -c1-36)
run_id=${run_id#-}
run_id=${run_id%-}
if [[ -z $run_id ]]; then
  echo "PGWB_PLAYWRIGHT_RUN_ID must contain at least one ASCII letter or digit." >&2
  exit 2
fi

results_parent="$extension_root/test-results/docker"
results_root="$results_parent/$run_id"
mkdir -p "$results_parent"
if ! mkdir "$results_root" 2>/dev/null; then
  echo "Refusing to overwrite existing Playwright evidence: $results_root" >&2
  exit 2
fi

active_projects=()

cleanup_projects() {
  if [[ ${PGWB_PLAYWRIGHT_DOCKER_KEEP:-0} != "1" ]]; then
    for project_name in "${active_projects[@]}"; do
      docker compose --project-name "$project_name" -f "$compose_file" down -v --remove-orphans --rmi local >/dev/null 2>&1 || true
    done
  fi
}

trap cleanup_projects EXIT INT TERM

run_lane() {
  local lane=$1
  shift
  local script_name
  local service_name
  local project_name="pgwb-pw-$run_id-$lane"
  local lane_results="$results_root/$lane"

  case "$lane" in
    bootstrap)
      script_name=test:bootstrap
      service_name=bootstrap-runner
      ;;
    core)
      script_name=test:acceptance:core
      service_name=runner
      ;;
    schema-sync)
      script_name=test:acceptance:schema-sync
      service_name=runner
      ;;
  esac

  mkdir -p "$lane_results"
  export PGWB_PLAYWRIGHT_RESULTS_DIR="$lane_results"
  active_projects+=("$project_name")

  echo "Running Playwright $lane lane in Compose project $project_name"
  docker compose --progress plain --project-name "$project_name" -f "$compose_file" build "$service_name"
  if [[ $lane != bootstrap ]]; then
    docker compose --progress plain --project-name "$project_name" -f "$compose_file" up -d --wait postgres
    local postgres_container
    local postgres_image
    postgres_container=$(docker compose --project-name "$project_name" -f "$compose_file" ps -q postgres)
    postgres_image=$(docker inspect --format '{{.Image}}' "$postgres_container")
    echo "PostgreSQL fixture image: $postgres_image"
  fi

  local status=0
  docker compose --progress plain --project-name "$project_name" -f "$compose_file" run --rm --no-deps "$service_name" "$script_name" "$@" || status=$?

  if [[ ${PGWB_PLAYWRIGHT_DOCKER_KEEP:-0} != "1" ]]; then
    docker compose --project-name "$project_name" -f "$compose_file" down -v --remove-orphans --rmi local
  else
    echo "Kept Compose project $project_name for diagnosis."
  fi

  return "$status"
}

for lane in "${lanes[@]}"; do
  run_lane "$lane" "$@"
done

echo "Playwright evidence: $results_root"
