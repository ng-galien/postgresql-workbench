#!/bin/sh
set -eu

host="${PGWB_POSTGRES_READY_HOST:-127.0.0.1}"
port="${PGWB_POSTGRES_READY_PORT:-${PGPORT:-5432}}"
user="${POSTGRES_USER:-postgres}"
database="${POSTGRES_DB:-$user}"

exec pg_isready -h "$host" -p "$port" -U "$user" -d "$database"
