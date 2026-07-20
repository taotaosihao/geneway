#!/usr/bin/env bash
set -euo pipefail

export DATABASE_URL="${DATABASE_URL:-postgres://geneway:geneway@127.0.0.1:55433/geneway_test}"

docker compose -f scripts/docker-compose.yml up -d --wait postgres >/dev/null
pnpm db:migrate >/dev/null
"$@"
