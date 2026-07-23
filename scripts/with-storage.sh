#!/usr/bin/env bash
set -euo pipefail

pick_ports() {
  node --input-type=module <<'NODE'
import net from 'node:net';
const servers = Array.from({ length: 4 }, () => net.createServer());
await Promise.all(servers.map((server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
})));
const ports = servers.map((server) => server.address()).map((address) => {
  if (typeof address === 'string' || address === null) throw new Error('unable to reserve loopback port');
  return address.port;
});
if (new Set(ports).size !== servers.length) throw new Error('loopback port reservation collision');
await Promise.all(servers.map((server) => new Promise((resolve, reject) =>
  server.close((error) => error === undefined ? resolve() : reject(error)))));
console.log(ports.join(' '));
NODE
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
  GENEWAY_POSTGRES_PORT=''
  GENEWAY_S3_PORT=''
  GENEWAY_STORAGE_ADAPTER_PORT=''
  GENEWAY_RECONCILIATION_ADAPTER_PORT=''
  if ! read -r GENEWAY_POSTGRES_PORT GENEWAY_S3_PORT GENEWAY_STORAGE_ADAPTER_PORT \
    GENEWAY_RECONCILIATION_ADAPTER_PORT < <(pick_ports); then
    echo 'unable to reserve four distinct loopback ports' >&2
    exit 1
  fi
  [[ "$GENEWAY_POSTGRES_PORT" =~ ^[1-9][0-9]*$ && "$GENEWAY_S3_PORT" =~ ^[1-9][0-9]*$ \
    && "$GENEWAY_STORAGE_ADAPTER_PORT" =~ ^[1-9][0-9]*$ && "$GENEWAY_RECONCILIATION_ADAPTER_PORT" =~ ^[1-9][0-9]*$ \
    && "$GENEWAY_POSTGRES_PORT" != "$GENEWAY_S3_PORT" && "$GENEWAY_POSTGRES_PORT" != "$GENEWAY_STORAGE_ADAPTER_PORT" \
    && "$GENEWAY_POSTGRES_PORT" != "$GENEWAY_RECONCILIATION_ADAPTER_PORT" && "$GENEWAY_S3_PORT" != "$GENEWAY_STORAGE_ADAPTER_PORT" \
    && "$GENEWAY_S3_PORT" != "$GENEWAY_RECONCILIATION_ADAPTER_PORT" \
    && "$GENEWAY_STORAGE_ADAPTER_PORT" != "$GENEWAY_RECONCILIATION_ADAPTER_PORT" ]] || {
    echo 'loopback port reservation did not return four distinct ports' >&2
    exit 1
  }
  export GENEWAY_POSTGRES_PORT GENEWAY_S3_PORT GENEWAY_STORAGE_ADAPTER_PORT GENEWAY_RECONCILIATION_ADAPTER_PORT
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
export GENEWAY_CURSOR_HMAC_SECRET="$(random_secret)"
export GENEWAY_STORAGE_ALLOWED_PREFIX='tenants/tenant_local/artifacts/'

proxy_pids=()
proxy_start_ticks=()
proxy_pgids=()
proxy_sids=()
proxy_control_fds=()
proxy_logs=()
proxy_root=''
start_proxy() {
  local name="$1" service="$2" network="$3" listen_port="$4" target_port="$5"
  local log="${proxy_root}/loopback-proxies/${COMPOSE_PROJECT_NAME}-${name}.controller.log"
  local control_fifo="${proxy_root}/loopback-proxies/${COMPOSE_PROJECT_NAME}-${name}.control"
  mkdir -p "$(dirname "$log")"
  chmod 0700 "$proxy_root" "$(dirname "$log")"
  ( set -o noclobber; umask 077; : >"$log" )
  mkfifo -m 0600 "$control_fifo"
  env -i PATH="$PATH" HOME="$HOME" LANG="${LANG:-C.UTF-8}" \
    setsid node scripts/gate02b-loopback-proxy.mjs --control "$proxy_root" "$name" "$COMPOSE_PROJECT_NAME" \
      "$service" "${COMPOSE_PROJECT_NAME}_${network}" "$listen_port" "$target_port" \
      "$GENEWAY_GATE02B_EGRESS_GUARD_LIBRARY" <"$control_fifo" >"$log" 2>&1 &
  local pid=$!
  local control_fd
  exec {control_fd}>"$control_fifo"
  unlink "$control_fifo"
  local start_ticks pgid sid ppid stat_line stat_fields state
  start_ticks=''
  pgid=''
  sid=''
  ppid=''
  for _ in $(seq 1 20); do
    if IFS= read -r stat_line 2>/dev/null <"/proc/${pid}/stat"; then
      stat_fields="${stat_line##*) }"
      read -r -a stat_fields <<<"$stat_fields"
      state="${stat_fields[0]:-}"
      ppid="${stat_fields[1]:-}"
      pgid="${stat_fields[2]:-}"
      sid="${stat_fields[3]:-}"
      start_ticks="${stat_fields[19]:-}"
      [[ "$state" != Z* && "$start_ticks" =~ ^[0-9]+$ && "$pgid" == "$pid" && "$sid" == "$pid" && "$ppid" == "$$" ]] && break
    fi
    sleep 0.01
  done
  [[ "$state" != Z* && "$start_ticks" =~ ^[0-9]+$ && "$pgid" == "$pid" && "$sid" == "$pid" && "$ppid" == "$$" ]] || {
    echo "loopback proxy did not inherit the private control pipe as a direct child: $name" >&2
    proxy_pids+=("$pid")
    proxy_start_ticks+=("${start_ticks:-unknown}")
    proxy_pgids+=("${pgid:-unknown}")
    proxy_sids+=("${sid:-unknown}")
    proxy_control_fds+=("$control_fd")
    proxy_logs+=("$log")
    return 1
  }
  proxy_pids+=("$pid")
  proxy_start_ticks+=("$start_ticks")
  proxy_pgids+=("$pgid")
  proxy_sids+=("$sid")
  proxy_control_fds+=("$control_fd")
  proxy_logs+=("$log")
  for _ in $(seq 1 100); do
    grep -q '"ready":true' "$log" && return
    kill -0 "$pid" 2>/dev/null || { cat "$log" >&2; return 1; }
    sleep 0.05
  done
  echo "loopback proxy did not become ready: $name" >&2
  return 1
}
stop_proxies() {
  local index pid control_fd failed=0 identity_status
  trap '' PIPE
  controller_identity_status() {
    local identity_index="$1" controller_pid stat_line stat_fields state current_ticks current_ppid current_pgid current_sid
    controller_pid="${proxy_pids[$identity_index]}"
    if ! IFS= read -r stat_line 2>/dev/null <"/proc/${controller_pid}/stat"; then return 2; fi
    stat_fields="${stat_line##*) }"
    read -r -a stat_fields <<<"$stat_fields"
    state="${stat_fields[0]:-}"
    [[ "$state" != Z* ]] || return 2
    current_ppid="${stat_fields[1]:-}"
    current_pgid="${stat_fields[2]:-}"
    current_sid="${stat_fields[3]:-}"
    current_ticks="${stat_fields[19]:-}"
    [[ "$current_ticks" == "${proxy_start_ticks[$identity_index]}"
      && "$current_ppid" == "$$"
      && "$current_pgid" == "${proxy_pgids[$identity_index]}"
      && "$current_sid" == "${proxy_sids[$identity_index]}" ]]
  }
  for index in "${!proxy_pids[@]}"; do
    control_fd="${proxy_control_fds[$index]}"
    printf 'shutdown\n' >&"$control_fd" || failed=1
    exec {control_fd}>&-
  done
  for index in "${!proxy_pids[@]}"; do
    pid="${proxy_pids[$index]}"
    for _ in $(seq 1 80); do
      controller_identity_status "$index" || break
      sleep 0.05
    done
    identity_status=0
    controller_identity_status "$index" || identity_status=$?
    if [[ "$identity_status" -eq 0 ]]; then
      echo "loopback proxy ignored its private shutdown pipe: $pid" >&2
      failed=1
      continue
    elif [[ "$identity_status" -ne 2 ]]; then
      echo "loopback proxy identity changed after private-pipe shutdown: $pid" >&2
      failed=1
      continue
    fi
    wait "$pid" || failed=1
  done
  proxy_pids=()
  proxy_start_ticks=()
  proxy_pgids=()
  proxy_sids=()
  proxy_control_fds=()
  return "$failed"
}

compose=(docker compose -f scripts/docker-compose.yml)
if [[ "${GENEWAY_GATE02B_EGRESS_GUARD:-}" == "required" ]]; then
  : "${GENEWAY_GATE02B_PROXY_RUN_ROOT:?Gate 0.2B proxy requires explicit run root}"
  : "${GENEWAY_GATE02B_EGRESS_GUARD_LIBRARY:?Gate 0.2B proxy requires guard library}"
  proxy_root="$GENEWAY_GATE02B_PROXY_RUN_ROOT"
  compose=(env \
    GENEWAY_POSTGRES_PORT="$GENEWAY_POSTGRES_PORT" GENEWAY_S3_PORT="$GENEWAY_S3_PORT" \
    GENEWAY_STORAGE_ADAPTER_PORT="$GENEWAY_STORAGE_ADAPTER_PORT" GENEWAY_RECONCILIATION_ADAPTER_PORT="$GENEWAY_RECONCILIATION_ADAPTER_PORT" \
    docker --host unix:///var/run/docker.sock compose -f scripts/docker-compose.yml)
fi
if [[ "${GENEWAY_STORAGE_TARGET_ROLE:-test}" != 'control-plane' ]]; then
  compose+=(-f scripts/docker-compose.host-storage.yml)
fi
pull_policy=()
if [[ "${GENEWAY_GATE02B_EGRESS_GUARD:-}" == "required" ]]; then
  pull_policy=(--pull never)
fi

if [[ "${GENEWAY_GATE02B_EGRESS_GUARD:-}" == "required" ]]; then
  invocation_kind='storage'
  [[ "${GENEWAY_MANAGED_TEST_INFRA:-0}" == '1' ]] && invocation_kind='e2e'
  invocation_root="${proxy_root}/invocations"
  mkdir -p "$proxy_root" "$invocation_root"
  chmod 0700 "$proxy_root" "$invocation_root"
  GENEWAY_INVOCATION_PATH="${invocation_root}/${COMPOSE_PROJECT_NAME}.json" \
  GENEWAY_INVOCATION_KIND="$invocation_kind" \
  GENEWAY_INVOCATION_PARENT_RUN_ID="${GENEWAY_PARENT_RUN_ID:-${GENEWAY_RUN_ID:-}}" \
  GENEWAY_INVOCATION_RUN_ID="${GENEWAY_RUN_ID:-}" \
  GENEWAY_INVOCATION_PROJECT="$COMPOSE_PROJECT_NAME" \
  GENEWAY_INVOCATION_POSTGRES_PORT="$GENEWAY_POSTGRES_PORT" \
  GENEWAY_INVOCATION_S3_PORT="$GENEWAY_S3_PORT" \
  GENEWAY_INVOCATION_STORAGE_PORT="$GENEWAY_STORAGE_ADAPTER_PORT" \
  GENEWAY_INVOCATION_RECONCILIATION_PORT="$GENEWAY_RECONCILIATION_ADAPTER_PORT" \
  node --input-type=module - <<'NODE'
import { lstatSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const env = process.env;
for (const path of [dirname(dirname(env.GENEWAY_INVOCATION_PATH)), dirname(env.GENEWAY_INVOCATION_PATH)]) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw new Error(`unsafe invocation directory: ${path}`);
}
const project = env.GENEWAY_INVOCATION_PROJECT;
const service = (name, network, listenPort, targetPort) => ({
  name, network, listenPort: Number(listenPort), targetPort, stem: `${project}-${name}`,
});
const manifest = {
  schemaVersion: 'geneway-gate02b-storage-invocation/1', kind: env.GENEWAY_INVOCATION_KIND,
  parentRunId: env.GENEWAY_INVOCATION_PARENT_RUN_ID || null, runId: env.GENEWAY_INVOCATION_RUN_ID || null,
  project, networks: { default: `${project}_default`, storage: `${project}_storage` },
  services: [service('postgres', 'default', env.GENEWAY_INVOCATION_POSTGRES_PORT, 5432),
    service('versitygw', 'storage', env.GENEWAY_INVOCATION_S3_PORT, 7070),
    service('storage-adapter', 'storage', env.GENEWAY_INVOCATION_STORAGE_PORT, 7400),
    service('storage-reconciliation-adapter', 'storage', env.GENEWAY_INVOCATION_RECONCILIATION_PORT, 7401)],
};
writeFileSync(env.GENEWAY_INVOCATION_PATH, `${JSON.stringify(manifest)}\n`, { flag: 'wx', mode: 0o600 });
NODE
fi

cleanup_done=0
cleanup_once() {
  [[ "$cleanup_done" == '0' ]] || return 0
  cleanup_done=1
  local proxy_cleanup_failed=0
  stop_proxies || proxy_cleanup_failed=1
  if [[ "${GENEWAY_KEEP_TEST_INFRA:-0}" == '1' ]]; then
    echo "kept disposable test infrastructure: ${COMPOSE_PROJECT_NAME}" >&2
    return "$proxy_cleanup_failed"
  fi
  if ! "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1; then
    [[ "${GENEWAY_GATE02B_EGRESS_GUARD:-}" == 'required' ]] && proxy_cleanup_failed=1
  fi
  return "$proxy_cleanup_failed"
}
on_exit() {
  local status=$?
  trap - EXIT
  cleanup_once || { [[ "$status" -ne 0 ]] || status=1; }
  exit "$status"
}
on_int() { exit 130; }
on_term() { exit 143; }
trap on_exit EXIT
trap on_int INT
trap on_term TERM

"${compose[@]}" up -d --wait "${pull_policy[@]}" postgres versitygw >/dev/null
if [[ "${GENEWAY_GATE02B_EGRESS_GUARD:-}" == "required" ]]; then
  start_proxy postgres postgres default "$GENEWAY_POSTGRES_PORT" 5432
  start_proxy versitygw versitygw storage "$GENEWAY_S3_PORT" 7070
fi
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

"${compose[@]}" run -T storage-provisioner ./node_modules/.bin/tsx scripts/provision-storage.ts >/dev/null
"${compose[@]}" run -T storage-provisioner ./node_modules/.bin/tsx scripts/verify-storage-permissions.ts >/dev/null

if "${compose[@]}" exec -T versitygw \
  versitygw admin --access "$GENEWAY_S3_APP_ACCESS_KEY_ID" --secret "$GENEWAY_S3_APP_SECRET_ACCESS_KEY" \
  --endpoint-url http://127.0.0.1:7071 list-users >/dev/null 2>&1; then
  echo 'online storage identity unexpectedly accessed VersityGW admin API' >&2
  exit 1
fi

"${compose[@]}" up -d --wait "${pull_policy[@]}" storage-adapter storage-reconciliation-adapter storage-oracle >/dev/null
if [[ "${GENEWAY_GATE02B_EGRESS_GUARD:-}" == "required" ]]; then
  start_proxy storage-adapter storage-adapter storage "$GENEWAY_STORAGE_ADAPTER_PORT" 7400
  start_proxy storage-reconciliation-adapter storage-reconciliation-adapter storage \
    "$GENEWAY_RECONCILIATION_ADAPTER_PORT" 7401
fi
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
  "${compose[@]}" up -d "${pull_policy[@]}" storage-reconciler >/dev/null
fi

base_env=(
  PATH="$PATH"
  HOME="$HOME"
  TMPDIR="${TMPDIR:-/tmp}"
  LANG="${LANG:-C.UTF-8}"
  NODE_ENV=test
  DATABASE_URL="$DATABASE_URL"
  GENEWAY_CURSOR_HMAC_SECRET="$GENEWAY_CURSOR_HMAC_SECRET"
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
