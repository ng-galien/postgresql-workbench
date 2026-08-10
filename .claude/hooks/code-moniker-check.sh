#!/usr/bin/env sh
set -eu

root="${CLAUDE_PROJECT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}"
cd "$root"

input_file=$(mktemp "${TMPDIR:-/tmp}/code-moniker-hook.XXXXXX")
trap 'rm -f "$input_file"' EXIT HUP INT TERM
cat > "$input_file"
files=$('/Users/alexandreboyer/.cargo/bin/code-moniker' harness tool-files claude "$input_file" 2>/dev/null) || {
	printf '%s\n' 'code-moniker hook could not inspect tool input' >&2
	exit 2
}

set -- '.'
while IFS= read -r file; do
	[ -n "$file" ] || continue
	set -- "$@" --file "$file"
done <<CODE_MONIKER_FILES
$files
CODE_MONIKER_FILES

if [ "$#" -eq 1 ]; then
	exit 0
fi

set +e
output=$('/Users/alexandreboyer/.cargo/bin/code-moniker' check --rules '.code-moniker.toml' --max-violations 10 "$@" 2>&1)
status=$?
set -e

if [ -n "$output" ]; then
	if [ "$status" -eq 0 ]; then
		printf '%s\n' "$output"
	else
		printf '%s\n' "$output" >&2
	fi
fi

if [ "$status" -eq 1 ]; then
	exit 2
fi

exit "$status"
