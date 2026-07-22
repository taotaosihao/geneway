#!/usr/bin/env bash
set -euo pipefail

pick_port() {
  node --input-type=module -e "import net from 'node:net'; const server=net.createServer(); server.listen(0,'127.0.0.1',()=>{ const address=server.address(); if(typeof address==='string'||address===null) process.exit(1); console.log(address.port); server.close(); });"
}

random_secret() {
  node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('hex'));"
}

if [[ "${GENEWAY_MANAGED_TEST_INFRA:-0}" == '1' ]]; then
  : "${GENEWAY_POSTGRES_PORT:?managed test infra requires GENEWAY_POSTGRES_PORT}"
  : "${GENEWAY_S3_PORT:?managed test infra requires GENEWAY_S3_PORT}"
  : "${GENEWAY_STORAGE_ADAPTER_PORT:?managed test infra requires GENEWAY_STORAGE_ADAPTER_PORT}"
  : "${GENEWAY_RECONCILIATION_ADAPTER_PORT:?managed test infra requires GENEWAY_RECONCILIATION_ADAPTER_PORT}"
  : "${DATABASE_URL:?managed test infra requires DATABASE_URL}"
  : "${GENEWAY_S3_ENDPOINT:?managed test infra requires GENEWAY_S3_ENDPOINT}"
  : "${COMPOSE_PROJECT_NAME:?managed test infra requires COMPOSE_PROJECT_NAME}"
  [[ "$DATABASE_URL" == "postgres://geneway:geneway@127.0.0.1:${GENEWAY_POSTGRES_PORT}/geneway_test" ]] || { echo 'managed DATABASE_URL is not the disposable loopback database' >&2; exit 1; }
  [[ "$GENEWAY_S3_ENDPOINT" == "http://127.0.0.1:${GENEWAY_S3_PORT}" ]] || { echo 'managed S3 endpoint is not loopback' >&2; exit 1; }
  [[ "$COMPOSE_PROJECT_NAME" == geneway-e2e-* ]] || { echo 'managed compose project is not an E2E project' >&2; exit 1; }
else
  export GENEWAY_POSTGRES_PORT="$(pick_port)"
  export GENEWAY_S3_PORT="$(pick_port)"
  export GENEWAY_STORAGE_ADAPTER_PORT="$(pick_port)"
  export GENEWAY_RECONCILIATION_ADAPTER_PORT="$(pick_port)"
  export DATABASE_URL="postgres://geneway:geneway@127.0.0.1:${GENEWAY_POSTGRES_PORT}/geneway_test"
  export GENEWAY_S3_ENDPOINT="http://127.0.0.1:${GENEWAY_S3_PORT}"
  export COMPOSE_PROJECT_NAME="geneway-storage-$$-$(date +%s)"
fi

export GENEWAY_S3_REGION='us-east-1'
export GENEWAY_S3_BUCKET='geneway-artifacts'
export GENEWAY_S3_ADMIN_ACCESS_KEY_ID="geneway-admin-${COMPOSE_PROJECT_NAME}"
export GENEWAY_S3_ADMIN_SECRET_ACCESS_KEY="$(random_secret)"
export GENEWAY_S3_APP_ACCESS_KEY_ID="geneway-online-${COMPOSE_PROJECT_NAME}"
export GENEWAY_S3_APP_SECRET_ACCESS_KEY="$(random_secret)"
export GENEWAY_S3_RECONCILER_ACCESS_KEY_ID="geneway-reconciler-${COMPOSE_PROJECT_NAME}"
export GENEWAY_S3_RECONCILER_SECRET_ACCESS_KEY="$(random_secret)"
export GENEWAY_E2E_S3_ORACLE_ACCESS_KEY_ID="geneway-oracle-${COMPOSE_PROJECT_NAME}"
export GENEWAY_E2E_S3_ORACLE_SECRET_ACCESS_KEY="$(random_secret)"
export GENEWAY_STORAGE_ADAPTER_TOKEN="$(random_secret)"
export GENEWAY_STORAGE_ADAPTER_URL="http://127.0.0.1:${GENEWAY_STORAGE_ADAPTER_PORT}"
export GENEWAY_RECONCILIATION_ADAPTER_TOKEN="$(random_secret)"
export GENEWAY_RECONCILIATION_ADAPTER_URL="http://127.0.0.1:${GENEWAY_RECONCILIATION_ADAPTER_PORT}"
export GENEWAY_STORAGE_ALLOWED_PREFIX='tenants/tenant_local/artifacts/'

compose=(docker compose -f scripts/docker-compose.yml)
if [[ "${GENEWAY_STORAGE_TARGET_ROLE:-test}" != 'control-plane' ]]; then
  compose+=(-f scripts/docker-compose.host-storage.yml)
fi

cleanup() {
  if [[ "${GENEWAY_KEEP_TEST_INFRA:-0}" == '1' ]]; then
    echo "kept disposable test infrastructure: ${COMPOSE_PROJECT_NAME}" >&2
    return
  fi
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

"${compose[@]}" up -d --wait postgres versitygw >/dev/null
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-C.UTF-8}" DATABASE_URL="$DATABASE_URL" \
  ./node_modules/.bin/tsx scripts/migrate.ts >/dev/null

"${compose[@]}" exec -T versitygw \
  versitygw admin --access "$GENEWAY_S3_ADMIN_ACCESS_KEY_ID" --secret "$GENEWAY_S3_ADMIN_SECRET_ACCESS_KEY" \
  --endpoint-url http://127.0.0.1:7071 create-user \
  --access "$GENEWAY_S3_APP_ACCESS_KEY_ID" --secret "$GENEWAY_S3_APP_SECRET_ACCESS_KEY" \
  --role user --user-id 1001 --group-id 1001 --project-id 1001 >/dev/null
"${compose[@]}" exec -T versitygw \
  versitygw admin --access "$GENEWAY_S3_ADMIN_ACCESS_KEY_ID" --secret "$GENEWAY_S3_ADMIN_SECRET_ACCESS_KEY" \
  --endpoint-url http://127.0.0.1:7071 create-user \
  --access "$GENEWAY_S3_RECONCILER_ACCESS_KEY_ID" --secret "$GENEWAY_S3_RECONCILER_SECRET_ACCESS_KEY" \
  --role user --user-id 1002 --group-id 1002 --project-id 1002 >/dev/null
"${compose[@]}" exec -T versitygw \
  versitygw admin --access "$GENEWAY_S3_ADMIN_ACCESS_KEY_ID" --secret "$GENEWAY_S3_ADMIN_SECRET_ACCESS_KEY" \
  --endpoint-url http://127.0.0.1:7071 create-user \
  --access "$GENEWAY_E2E_S3_ORACLE_ACCESS_KEY_ID" --secret "$GENEWAY_E2E_S3_ORACLE_SECRET_ACCESS_KEY" \
  --role user --user-id 1003 --group-id 1003 --project-id 1003 >/dev/null

"${compose[@]}" run --rm -T storage-provisioner ./node_modules/.bin/tsx scripts/provision-storage.ts >/dev/null
"${compose[@]}" run --rm -T storage-provisioner ./node_modules/.bin/tsx scripts/verify-storage-permissions.ts >/dev/null

if "${compose[@]}" exec -T versitygw \
  versitygw admin --access "$GENEWAY_S3_APP_ACCESS_KEY_ID" --secret "$GENEWAY_S3_APP_SECRET_ACCESS_KEY" \
  --endpoint-url http://127.0.0.1:7071 list-users >/dev/null 2>&1; then
  echo 'online storage identity unexpectedly accessed VersityGW admin API' >&2
  exit 1
fi

"${compose[@]}" up -d --wait storage-adapter storage-reconciliation-adapter storage-oracle >/dev/null
if ! GENEWAY_STORAGE_HEALTH_URL="${GENEWAY_STORAGE_ADAPTER_URL}/health" node --input-type=module - <<'NODE'
const url = process.env.GENEWAY_STORAGE_HEALTH_URL;
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    const response = await fetch(url);
    if (response.ok) process.exit(0);
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 50));
}
process.exit(1);
NODE
then
  "${compose[@]}" logs --no-color storage-adapter >&2
  exit 1
fi

"${compose[@]}" exec -T \
  -e GENEWAY_STORAGE_ADAPTER_URL=http://storage-adapter:7400 \
  -e GENEWAY_STORAGE_ADAPTER_TOKEN="$GENEWAY_STORAGE_ADAPTER_TOKEN" \
  -e GENEWAY_STORAGE_ALLOWED_PREFIX="$GENEWAY_STORAGE_ALLOWED_PREFIX" \
  storage-oracle ./node_modules/.bin/tsx scripts/verify-storage-adapter.ts >/dev/null

"${compose[@]}" exec -T \
  -e GENEWAY_RECONCILIATION_ADAPTER_URL=http://storage-reconciliation-adapter:7401 \
  -e GENEWAY_RECONCILIATION_ADAPTER_TOKEN="$GENEWAY_RECONCILIATION_ADAPTER_TOKEN" \
  -e GENEWAY_STORAGE_ALLOWED_PREFIX="$GENEWAY_STORAGE_ALLOWED_PREFIX" \
  storage-oracle ./node_modules/.bin/tsx scripts/verify-reconciliation-adapter.ts >/dev/null

if [[ "${GENEWAY_START_STORAGE_RECONCILER:-0}" == '1' ]]; then
  "${compose[@]}" up -d storage-reconciler >/dev/null
fi

base_env=(
  PATH="$PATH"
  HOME="$HOME"
  TMPDIR="${TMPDIR:-/tmp}"
  LANG="${LANG:-C.UTF-8}"
  NODE_ENV=test
  DATABASE_URL="$DATABASE_URL"
  GENEWAY_S3_BUCKET="$GENEWAY_S3_BUCKET"
  GENEWAY_STORAGE_ADAPTER_URL="$GENEWAY_STORAGE_ADAPTER_URL"
  GENEWAY_STORAGE_ADAPTER_TOKEN="$GENEWAY_STORAGE_ADAPTER_TOKEN"
  COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME"
)
[[ -n "${PORT:-}" ]] && base_env+=(PORT="$PORT")
[[ -n "${GENEWAY_WEB_PORT:-}" ]] && base_env+=(GENEWAY_WEB_PORT="$GENEWAY_WEB_PORT")
[[ -n "${GENEWAY_RUN_ID:-}" ]] && base_env+=(GENEWAY_RUN_ID="$GENEWAY_RUN_ID")

if [[ "${GENEWAY_STORAGE_TARGET_ROLE:-test}" == 'control-plane' ]]; then
  env -i "${base_env[@]}" node scripts/assert-process-env.mjs control-plane
  env -i "${base_env[@]}" "$@"
else
  env -i "${base_env[@]}" \
    GENEWAY_E2E_DATABASE_URL="$DATABASE_URL" \
    GENEWAY_E2E_S3_ENDPOINT="$GENEWAY_S3_ENDPOINT" \
    GENEWAY_E2E_S3_REGION="$GENEWAY_S3_REGION" \
    GENEWAY_E2E_S3_BUCKET="$GENEWAY_S3_BUCKET" \
    GENEWAY_E2E_S3_ORACLE_ACCESS_KEY_ID="$GENEWAY_E2E_S3_ORACLE_ACCESS_KEY_ID" \
    GENEWAY_E2E_S3_ORACLE_SECRET_ACCESS_KEY="$GENEWAY_E2E_S3_ORACLE_SECRET_ACCESS_KEY" \
    GENEWAY_RECONCILIATION_ADAPTER_URL="$GENEWAY_RECONCILIATION_ADAPTER_URL" \
    GENEWAY_RECONCILIATION_ADAPTER_TOKEN="$GENEWAY_RECONCILIATION_ADAPTER_TOKEN" \
    GENEWAY_STORAGE_ALLOWED_PREFIX="$GENEWAY_STORAGE_ALLOWED_PREFIX" \
    GENEWAY_S3_ENDPOINT="$GENEWAY_S3_ENDPOINT" \
    GENEWAY_S3_REGION="$GENEWAY_S3_REGION" \
    "$@"
fi
