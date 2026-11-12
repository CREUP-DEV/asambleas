#!/usr/bin/env bash
# Builds the production image, pushes it to GHCR and rolls it out on the VPS:
# migrations, optional RBAC seed, app recreate, health wait, NGINX reload and
# old image cleanup.
# Usage: bash ./scripts/deploy.sh [--seed]   (settings in the local .env, see DEPLOYMENT.md)
set -euo pipefail

# Settings, the build context and git all live at the repository root,
# whatever folder this is run from.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() {
  cat <<'EOF'
Usage:
  bash ./scripts/deploy.sh           build, push and roll out the current tree
  bash ./scripts/deploy.sh --seed    also run the RBAC seed (first deploy, or a new
                             permission key or system role). It puts back
                             every default grant, including ones removed by hand.
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

echo "== Apply database migrations =="
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
  echo "Roll back with: bash ./scripts/rollback.sh" >&2
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
for arg in "$@"; do
  case "$arg" in
    --seed) RUN_SEED=true ;;
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
if [ -z "${IMAGE_TAG:-}" ]; then
  IMAGE_TAG="$(git rev-parse --short HEAD)"
  if [ -n "$(git status --porcelain)" ]; then
    # Unique per build: a reused tag would change under the rollback file.
    DIRTY=true
    IMAGE_TAG="${IMAGE_TAG}-dirty-$(date -u +%Y%m%d%H%M%S)"
  fi
fi
IMAGE="${IMAGE:-${IMAGE_NAME}:${IMAGE_TAG}}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"
COMPOSE_APP_SERVICE="${COMPOSE_APP_SERVICE:-asambleas-app}"
COMPOSE_POSTGRES_SERVICE="${COMPOSE_POSTGRES_SERVICE:-postgresql}"
COMPOSE_NGINX_SERVICE="${COMPOSE_NGINX_SERVICE:-nginx}"
DEPLOY_IMAGE_RETENTION="${DEPLOY_IMAGE_RETENTION:-2}"
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

if [ "$DIRTY" = true ]; then
  printf 'WARNING: uncommitted changes; deploying them as %s\n' "$IMAGE" >&2
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
