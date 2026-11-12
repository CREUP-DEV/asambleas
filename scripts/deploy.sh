#!/usr/bin/env bash
# Verifies the tree (pnpm verify), builds the production image, pushes it to
# GHCR and rolls it out on the VPS: database dump, migrations, optional RBAC
# seed, app recreate, health wait, NGINX reload and old image cleanup.
# Usage: bash ./scripts/deploy.sh [--seed] [--allow-dirty]   (settings in the local .env, see DEPLOYMENT.md)
set -euo pipefail

# Settings, the build context and git all live at the repository root,
# whatever folder this is run from.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() {
  cat <<'EOF'
Usage:
  bash ./scripts/deploy.sh                verify, build, push and roll out the current tree
  bash ./scripts/deploy.sh --seed         also run the RBAC seed (first deploy, or a new
                                  permission key or system role). It puts back
                                  every default grant, including ones removed by hand.
  bash ./scripts/deploy.sh --allow-dirty  build a tree with uncommitted changes, tagged
                                  <commit>-dirty-<UTC date>

Environment:
  DEPLOY_SKIP_VERIFY=1        skip `pnpm verify` (lint, format, types, i18n, tests);
                              DEPLOY_SKIP_BUILD=1 does not skip it
  DEPLOY_SKIP_BUILD=1         deploy IMAGE without building it
  DEPLOY_ALLOW_IN_SESSION=1   deploy while an assembly is in session without
                              being asked, here or in the VPS re-check before
                              migrating (required when stdin is not a terminal)
EOF
}

log() {
  printf '== %s ==\n' "$1"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'ERROR: %s is not available locally\n' "$1" >&2
    exit 1
  }
}

# Under WSL (what a bare `bash` typed in PowerShell resolves to) the Linux ssh
# reads the distro's own ~/.ssh, without the keys and host aliases of
# %USERPROFILE%\.ssh. Windows' ssh.exe authenticates like every other shell.
resolve_ssh_bin() {
  SSH_BIN=ssh
  if [ -n "${WSL_DISTRO_NAME:-}" ] && command -v ssh.exe >/dev/null 2>&1; then
    SSH_BIN=ssh.exe
  fi
  require_command "$SSH_BIN"
}

load_env_file() {
  if [ -f "$1" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$1"
    set +a
  fi
}

# AGENTS.md's verification checklist minus the build, which the image does.
# Under WSL the tree's node_modules were installed by Windows' pnpm, with
# Windows native binaries (esbuild, rollup), so run it through Windows too.
run_verify() {
  if [ -n "${WSL_DISTRO_NAME:-}" ] && command -v cmd.exe >/dev/null 2>&1; then
    cmd.exe /c pnpm verify
    return
  fi
  require_command pnpm
  pnpm verify
}

# The assemblies in session, one "<number> <type>" per line. ASCII only: it
# travels %q-quoted through the remote login shell, here and in remote_deploy.
IN_SESSION_QUERY="SELECT number::text || ' ' || type::text FROM assemblies WHERE status = 'in_session' ORDER BY start_date"

# An assembly in session is being followed live: recreating the app cuts the
# room off for a few seconds and a migration can change what it reads. Asked
# here, before verify and the build, so nobody is asked after a long wait; the
# remote side checks again before migrating, since one may open meanwhile.
# Without a terminal it refuses unless DEPLOY_ALLOW_IN_SESSION=1: deliberately
# stricter than going on, since a script cannot answer and a session is the
# one moment a deploy hurts. A failed query (first deploy, no table yet) only
# warns. Sets ALLOW_IN_SESSION for the remote check.
confirm_no_session() {
  local in_session reply
  ALLOW_IN_SESSION=false
  if [ "${DEPLOY_ALLOW_IN_SESSION:-}" = 1 ]; then
    ALLOW_IN_SESSION=true
  fi
  if ! in_session="$(
    "$SSH_BIN" "$VPS_HOST" "cd $(printf '%q' "$COMPOSE_DIR") && docker compose exec -T $(printf '%q' "$COMPOSE_POSTGRES_SERVICE") psql -X -A -t -v ON_ERROR_STOP=1 -U $(printf '%q' "$DEPLOY_DB_USER") -d $(printf '%q' "$DEPLOY_DB_NAME") -c $(printf '%q' "$IN_SESSION_QUERY") </dev/null" </dev/null
  )"; then
    printf 'WARNING: could not check for an assembly in session; going on\n' >&2
    return 0
  fi
  in_session="${in_session//$'\r'/}"
  [ -n "$in_session" ] || return 0

  printf 'WARNING: assembly in session: %s\n' "$(sed 's/^\([0-9]*\) /\1.ª /' <<<"$in_session" | paste -sd ',' | sed 's/,/, /g')" >&2
  printf '         Deploying recreates the app (a few seconds offline) and migrates its database.\n' >&2
  if [ "$ALLOW_IN_SESSION" = true ]; then
    printf '         DEPLOY_ALLOW_IN_SESSION=1: going on\n' >&2
    return 0
  fi
  if [ ! -t 0 ]; then
    printf 'ERROR: no terminal to confirm; set DEPLOY_ALLOW_IN_SESSION=1 to deploy anyway\n' >&2
    exit 1
  fi
  read -r -p 'Deploy anyway? [y/N] ' reply
  case "$reply" in
    y | Y | yes | YES | s | S | si | SI) ALLOW_IN_SESSION=true ;;
    *)
      printf 'Deploy cancelled\n' >&2
      exit 1
      ;;
  esac
}

build_and_push_image() {
  local args=(
    --platform "$DOCKER_PLATFORM"
    --build-arg "NUXT_SITE_URL=$BUILD_SITE_URL"
    --build-arg "NUXT_PUBLIC_UMAMI_HOST=${NUXT_DEPLOY_UMAMI_HOST:-}"
    --build-arg "NUXT_PUBLIC_UMAMI_WEBSITE_ID=${NUXT_DEPLOY_UMAMI_WEBSITE_ID:-}"
    -t "$IMAGE"
  )
  # :latest only ever names a committed build.
  if [ "$DIRTY" = false ]; then
    args+=(-t "${IMAGE_NAME}:latest")
  fi

  if docker buildx version >/dev/null 2>&1; then
    docker buildx build "${args[@]}" --push .
    return
  fi

  docker build "${args[@]}" .
  docker push "$IMAGE"
  if [ "$DIRTY" = false ]; then
    docker push "${IMAGE_NAME}:latest"
  fi
}

# Runs on the VPS. Everything it needs arrives as environment variables set on
# the ssh command line (see remote_deploy), so this heredoc is quoted and
# nothing in it expands locally.
#
# Every command that could read stdin gets </dev/null: bash reads this script
# from stdin, so a child that reads it (docker compose exec and run do, even
# with -T) would swallow the rest of the script and end it early with status 0.
read -r -d '' REMOTE_SCRIPT <<'REMOTE' || true
set -euo pipefail

cd "$COMPOSE_DIR"
export ASAMBLEAS_IMAGE="$IMAGE"

wait_healthy() {
  local service="$1" seconds="$2" container_id status=missing
  container_id="$(docker compose ps -q "$service" </dev/null 2>/dev/null || true)"
  if [ -z "$container_id" ]; then
    echo "ERROR: no container for $service" >&2
    return 1
  fi
  for _ in $(seq 1 $((seconds / 3))); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container_id" 2>/dev/null || echo missing)"
    case "$status" in
      healthy) return 0 ;;
      no-healthcheck | missing) break ;;
    esac
    sleep 3
  done
  echo "ERROR: $service is $status" >&2
  return 1
}

# The image a container runs, by digest when the registry gave one, so a tag
# pushed again later cannot change what a rollback brings back.
pinned_image_of() {
  local container_id="$1" image_id ref digest
  image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
  ref="$(docker inspect --format '{{.Config.Image}}' "$container_id")"
  digest="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id" 2>/dev/null | grep -m1 -F "${IMAGE_NAME}@" || true)"
  printf '%s\n' "${digest:-$ref}"
}

psql_app_db() {
  docker compose exec -T "$POSTGRES_SERVICE" psql -X -A -t -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c "$1" </dev/null 2>/dev/null | tr -d '\r'
}

# How many migrations the database records; empty when it cannot tell (first
# deploy, before drizzle's schema exists).
applied_migrations() {
  psql_app_db 'SELECT count(*) FROM drizzle.__drizzle_migrations' || true
}

persist_image() {
  local line="ASAMBLEAS_IMAGE=$1" tmp
  if [ -f .env ] && grep -q '^ASAMBLEAS_IMAGE=' .env; then
    tmp="$(mktemp)"
    sed "s|^ASAMBLEAS_IMAGE=.*|$line|" .env >"$tmp"
    cat "$tmp" >.env
    rm -f "$tmp"
  else
    # Never glue the line onto another project's last key.
    if [ -s .env ] && [ -n "$(tail -c1 .env)" ]; then
      printf '\n' >>.env
    fi
    printf '%s\n' "$line" >>.env
  fi
  echo "    $line"
}

echo "== Check host data directories =="
# Created by the deploy user: left to Docker, a missing bind source is created
# as root and the app (uid $APP_UID) cannot write to it.
mkdir -p "$REMOTE_DIR/data/exports" "$REMOTE_DIR/data/uploads"
for dir in "$REMOTE_DIR/data/exports" "$REMOTE_DIR/data/uploads"; do
  owner="$(stat -c %u "$dir")"
  if [ "$owner" != "$APP_UID" ]; then
    echo "ERROR: $dir belongs to uid $owner; the app runs as uid $APP_UID and could not write PDFs there" >&2
    exit 1
  fi
done

echo "== Check PostgreSQL =="
# The database is shared by every project: never recreate it from here.
if [ -z "$(docker compose ps -q --status running "$POSTGRES_SERVICE" </dev/null 2>/dev/null || true)" ]; then
  echo "    not running, starting it"
  docker compose up -d --no-recreate "$POSTGRES_SERVICE" </dev/null
fi
wait_healthy "$POSTGRES_SERVICE" 60
echo "    healthy"

echo "== Save current app image for rollback =="
current_id="$(docker compose ps -q "$APP_SERVICE" </dev/null 2>/dev/null || true)"
if [ -z "$current_id" ]; then
  echo "    no app container yet"
elif [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$current_id")" = healthy ]; then
  pinned_image_of "$current_id" >"$ROLLBACK_IMAGE_FILE"
  echo "    $(cat "$ROLLBACK_IMAGE_FILE")"
else
  # A failed deploy left a broken container: keep the last good image.
  echo "    current app is not healthy, keeping $(cat "$ROLLBACK_IMAGE_FILE" 2>/dev/null || echo 'no saved image')"
fi

echo "== Pull image =="
# Tags are never reused (dirty builds carry a timestamp), so pull only when
# the VPS does not have it yet.
docker compose pull --policy missing "$APP_SERVICE" </dev/null

echo "== Check for an assembly in session =="
# Checked again: verify and the build may have taken long enough for one to
# open since the operator was asked. A failed query only goes on, as there.
if [ "$ALLOW_IN_SESSION" = true ]; then
  echo "    allowed by the operator"
else
  in_session="$(psql_app_db "$SESSION_QUERY" || true)"
  if [ -n "$in_session" ]; then
    echo "ERROR: an assembly entered session during the build ($(sed 's/^\([0-9]*\) /\1.ª /' <<<"$in_session" | paste -sd ',' | sed 's/,/, /g')); nothing was migrated. Run the deploy again to confirm" >&2
    exit 1
  fi
  echo "    none"
fi

echo "== Dump the database before migrating =="
# A migration that succeeds but transforms data wrongly cannot be undone, and
# the cluster-wide pg_dumpall runs only once a day: no dump, no deploy.
# Retention only ever touches this script's own files: the directory is shared
# with the daily dump and with manual copies.
mkdir -p "$DUMP_DIR"
# Left by a dump cut short (a dropped connection, Ctrl-C): never a usable one.
find "$DUMP_DIR" -maxdepth 1 -type f -name "${DB_NAME}-predeploy-*.dump.partial" -delete
dump_file="$DUMP_DIR/${DB_NAME}-predeploy-$(date -u +%Y%m%d-%H%M%S).dump"
if ! (umask 077 && docker compose exec -T "$POSTGRES_SERVICE" pg_dump -U "$DB_USER" -Fc "$DB_NAME" </dev/null >"$dump_file.partial") ||
  [ ! -s "$dump_file.partial" ]; then
  rm -f "$dump_file.partial"
  echo "ERROR: pg_dump of $DB_NAME failed; nothing was migrated" >&2
  exit 1
fi
mv "$dump_file.partial" "$dump_file"
echo "    $dump_file ($(du -h "$dump_file" | cut -f1))"
if [[ "$DUMP_RETENTION" =~ ^[0-9]+$ ]] && [ "$DUMP_RETENTION" -ge 1 ]; then
  removed=0
  # The UTC timestamp in the name sorts by date.
  while read -r old_dump; do
    [ -n "$old_dump" ] || continue
    rm -f "$old_dump"
    removed=$((removed + 1))
  done < <(find "$DUMP_DIR" -maxdepth 1 -type f -name "${DB_NAME}-predeploy-*.dump" | sort -r | tail -n +$((DUMP_RETENTION + 1)))
  echo "    kept the last $DUMP_RETENTION, removed $removed"
fi

echo "== Apply database migrations =="
migrations_before="$(applied_migrations)"
docker compose run -T --rm --no-deps "$APP_SERVICE" /app/ops/migrate.mjs </dev/null

if [ "$RUN_SEED" = true ]; then
  echo "== Seed roles and permissions =="
  docker compose run -T --rm --no-deps "$APP_SERVICE" /app/ops/seed.mjs </dev/null
fi

echo "== Recreate app container =="
docker compose up -d --no-deps "$APP_SERVICE" </dev/null

echo "== Wait for the app to be healthy =="
if ! wait_healthy "$APP_SERVICE" 120; then
  echo "Last logs:" >&2
  docker compose logs --tail 80 "$APP_SERVICE" </dev/null >&2 || true
  # rollback.sh refuses an image older than the database's migrations, so
  # say which way out applies, with the dump this deploy just wrote.
  migrations_after="$(applied_migrations)"
  echo "Pre-deploy dump: $dump_file" >&2
  if [[ "$migrations_before" =~ ^[0-9]+$ ]] && [[ "$migrations_after" =~ ^[0-9]+$ ]]; then
    if [ "$migrations_after" -le "$migrations_before" ]; then
      echo "This deploy applied no migration. Roll back with: bash ./scripts/rollback.sh" >&2
    else
      echo "This deploy applied $((migrations_after - migrations_before)) migration(s), so bash ./scripts/rollback.sh refuses: restore $dump_file first (DEPLOYMENT.md, Restaurar), then roll back; or bash ./scripts/rollback.sh --force if the previous release works with them" >&2
    fi
  else
    echo "Roll back with: bash ./scripts/rollback.sh. If this deploy applied migrations it refuses: restore $dump_file first (DEPLOYMENT.md, Restaurar), or pass --force if the previous release works with them" >&2
  fi
  exit 1
fi
echo "    healthy"

echo "== Persist ASAMBLEAS_IMAGE in .env =="
# Without it a later bare `docker compose up -d` (another project's deploy, a
# manual restart) would fall back to a stale ':latest'. Written only once the
# app is healthy, so that `up -d` after a failed deploy brings back the last
# good image.
persist_image "$IMAGE"

services="$(docker compose config --services </dev/null)"
if grep -qx "$NGINX_SERVICE" <<<"$services"; then
  echo "== Reload NGINX =="
  docker compose exec -T "$NGINX_SERVICE" nginx -t </dev/null
  docker compose exec -T "$NGINX_SERVICE" nginx -s reload </dev/null
fi

if [[ "$IMAGE_RETENTION" =~ ^[0-9]+$ ]] && [ "$IMAGE_RETENTION" -ge 1 ]; then
  echo "== Remove old app images =="
  keep_ids=" $(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || true) "
  if [ -s "$ROLLBACK_IMAGE_FILE" ]; then
    keep_ids+=" $(docker image inspect --format '{{.Id}}' "$(cat "$ROLLBACK_IMAGE_FILE")" 2>/dev/null || true) "
  fi
  kept=0
  removed=0
  # Newest first, sorted here: the containerd image store does not list them
  # in creation order. One ID can carry several tags.
  while read -r id; do
    [ -n "$id" ] || continue
    full_id="$(docker image inspect --format '{{.Id}}' "$id")"
    if [[ "$keep_ids" == *" $full_id "* ]] || [ "$kept" -lt "$IMAGE_RETENTION" ]; then
      kept=$((kept + 1))
      continue
    fi
    if docker image rm -f "$id" >/dev/null 2>&1; then
      removed=$((removed + 1))
    fi
  done < <(docker image ls "$IMAGE_NAME" --format '{{.CreatedAt}}|{{.ID}}' | sort -r | cut -d'|' -f2 | awk '!seen[$0]++')
  echo "    kept $kept, removed $removed"
fi

echo "== Remote deploy done =="
REMOTE

remote_deploy() {
  local remote_env
  remote_env="$(printf '%q=%q ' \
    COMPOSE_DIR "$COMPOSE_DIR" \
    REMOTE_DIR "$REMOTE_DIR" \
    IMAGE "$IMAGE" \
    IMAGE_NAME "$IMAGE_NAME" \
    APP_SERVICE "$COMPOSE_APP_SERVICE" \
    POSTGRES_SERVICE "$COMPOSE_POSTGRES_SERVICE" \
    NGINX_SERVICE "$COMPOSE_NGINX_SERVICE" \
    ROLLBACK_IMAGE_FILE "$ROLLBACK_IMAGE_FILE" \
    IMAGE_RETENTION "$DEPLOY_IMAGE_RETENTION" \
    APP_UID "$APP_UID" \
    DB_NAME "$DEPLOY_DB_NAME" \
    DB_USER "$DEPLOY_DB_USER" \
    DUMP_DIR "$DEPLOY_DUMP_DIR" \
    DUMP_RETENTION "$DEPLOY_DUMP_RETENTION" \
    SESSION_QUERY "$IN_SESSION_QUERY" \
    ALLOW_IN_SESSION "$ALLOW_IN_SESSION" \
    RUN_SEED "$RUN_SEED")"
  # The remote side must say it finished: a script cut short (a swallowed
  # stdin, a dropped connection) cannot pass for a successful deploy.
  local output_marker="== Remote deploy done =="
  local status=0
  local log_file
  log_file="$(mktemp)"
  "$SSH_BIN" "$VPS_HOST" "env ${remote_env}bash -se" <<<"$REMOTE_SCRIPT" | tee "$log_file" || status=$?
  if [ "$status" -ne 0 ]; then
    rm -f "$log_file"
    exit "$status"
  fi
  if ! grep -qxF "$output_marker" "$log_file"; then
    rm -f "$log_file"
    printf 'ERROR: the remote deploy stopped before its last step\n' >&2
    exit 1
  fi
  rm -f "$log_file"
}

RUN_SEED=false
ALLOW_DIRTY=false
for arg in "$@"; do
  case "$arg" in
    --seed) RUN_SEED=true ;;
    --allow-dirty) ALLOW_DIRTY=true ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'ERROR: unknown argument: %s\n' "$arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

load_env_file ".env"

: "${VPS_HOST:?ERROR: VPS_HOST is required}"
: "${COMPOSE_DIR:?ERROR: COMPOSE_DIR is required (the shared root compose directory)}"

require_command docker
require_command git
resolve_ssh_bin

REMOTE_DIR="${REMOTE_DIR:-${COMPOSE_DIR}/asambleas}"
IMAGE_NAME="${IMAGE_NAME:-ghcr.io/creup-dev/asambleas}"
DIRTY=false
if [ -n "$(git status --porcelain)" ]; then
  DIRTY=true
fi
if [ -z "${IMAGE_TAG:-}" ]; then
  IMAGE_TAG="$(git rev-parse --short HEAD)"
  if [ "$DIRTY" = true ]; then
    # Unique per build: a reused tag would change under the rollback file.
    IMAGE_TAG="${IMAGE_TAG}-dirty-$(date -u +%Y%m%d%H%M%S)"
  fi
fi
IMAGE="${IMAGE:-${IMAGE_NAME}:${IMAGE_TAG}}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"
COMPOSE_APP_SERVICE="${COMPOSE_APP_SERVICE:-asambleas-app}"
COMPOSE_POSTGRES_SERVICE="${COMPOSE_POSTGRES_SERVICE:-postgresql}"
COMPOSE_NGINX_SERVICE="${COMPOSE_NGINX_SERVICE:-nginx}"
DEPLOY_IMAGE_RETENTION="${DEPLOY_IMAGE_RETENTION:-2}"
DEPLOY_DB_NAME="${DEPLOY_DB_NAME:-asambleas}"
DEPLOY_DB_USER="${DEPLOY_DB_USER:-asambleas}"
# Pre-migration dumps, relative to COMPOSE_DIR (restic takes backups/ off the VPS).
DEPLOY_DUMP_DIR="${DEPLOY_DUMP_DIR:-backups/db}"
DEPLOY_DUMP_RETENTION="${DEPLOY_DUMP_RETENTION:-10}"
ROLLBACK_IMAGE_FILE="${ROLLBACK_IMAGE_FILE:-.last_asambleas_image}"
# The uid the image runs as (Dockerfile USER).
APP_UID="${APP_UID:-1000}"
# The local .env keeps NUXT_SITE_URL on localhost for development.
BUILD_SITE_URL="${NUXT_DEPLOY_SITE_URL:-https://asambleas.creup.es}"

case "$BUILD_SITE_URL" in
  https://*) ;;
  *)
    printf 'ERROR: NUXT_DEPLOY_SITE_URL must be the public https origin, got %s\n' "$BUILD_SITE_URL" >&2
    exit 1
    ;;
esac

# Building a tree with uncommitted changes (another session's half-done work,
# say) must be a decision: the -dirty-<date> tag keeps it apart for rollbacks.
if [ "$DIRTY" = true ] && [ "${DEPLOY_SKIP_BUILD:-}" != 1 ]; then
  if [ "$ALLOW_DIRTY" != true ]; then
    printf 'ERROR: uncommitted changes (git status); commit them, or pass --allow-dirty to deploy them as %s\n' "$IMAGE" >&2
    exit 1
  fi
  printf 'WARNING: uncommitted changes; deploying them as %s\n' "$IMAGE" >&2
fi

confirm_no_session

if [ "${DEPLOY_SKIP_VERIFY:-}" = 1 ]; then
  printf 'WARNING: DEPLOY_SKIP_VERIFY=1: lint, format, types, i18n and tests not run\n' >&2
else
  log "Verify: pnpm verify"
  run_verify
fi

if [ "${DEPLOY_SKIP_BUILD:-}" = 1 ]; then
  log "Skip build: $IMAGE must already be in the registry or on the VPS"
else
  if [ -n "${GHCR_USERNAME:-}" ] && [ -n "${GHCR_TOKEN:-}" ]; then
    log "GHCR login"
    printf '%s\n' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin
  fi

  log "Build and push: $IMAGE (embeds $BUILD_SITE_URL)"
  build_and_push_image
fi

log "Deploy to $VPS_HOST:$COMPOSE_DIR (seed: $RUN_SEED)"
remote_deploy

printf 'Deploy finished successfully: %s\n' "$IMAGE"
