#!/usr/bin/env bash
set -euo pipefail

export GENEWAY_POSTGRES_PORT="$(node --input-type=module -e "import net from 'node:net'; const server=net.createServer(); server.listen(0,'127.0.0.1',()=>{ const address=server.address(); if(typeof address==='string'||address===null) process.exit(1); console.log(address.port); server.close(); });")"
export DATABASE_URL="postgres://geneway:geneway@127.0.0.1:${GENEWAY_POSTGRES_PORT}/geneway_test"
export COMPOSE_PROJECT_NAME="geneway-postgres-$$-$(date +%s)"

cleanup() {
  docker compose -f scripts/docker-compose.postgres.yml down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker compose -f scripts/docker-compose.postgres.yml up -d --wait postgres >/dev/null
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-C.UTF-8}" DATABASE_URL="$DATABASE_URL" \
  ./node_modules/.bin/tsx scripts/migrate.ts >/dev/null
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-C.UTF-8}" NODE_ENV=test DATABASE_URL="$DATABASE_URL" "$@"
