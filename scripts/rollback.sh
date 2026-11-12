#!/usr/bin/env bash
# Puts the previous app image back on the VPS and waits for it to be healthy.
# Migrations are not reverted.
set -euo pipefail

# Settings, the build context and git all live at the repository root,
# whatever folder this is run from.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() {
  cat <<'EOF'
Usage:
  bash ./scripts/rollback.sh            the image saved by the last successful deploy
  bash ./scripts/rollback.sh <tag>      ghcr.io/creup-dev/asambleas:<tag>
  bash ./scripts/rollback.sh <ref>      a full image reference (repo:tag or repo@sha256:...)
EOF
}

log() {
  printf '== %s ==\n' "$1"
}

# Same reason as in deploy.sh: under WSL, use Windows' ssh.exe.
resolve_ssh_bin() {
  SSH_BIN=ssh
  if [ -n "${WSL_DISTRO_NAME:-}" ] && command -v ssh.exe >/dev/null 2>&1; then
    SSH_BIN=ssh.exe
  fi
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

: "${VPS_HOST:?ERROR: VPS_HOST is required}"
: "${COMPOSE_DIR:?ERROR: COMPOSE_DIR is required}"

resolve_ssh_bin

IMAGE_NAME="${IMAGE_NAME:-ghcr.io/creup-dev/asambleas}"
COMPOSE_APP_SERVICE="${COMPOSE_APP_SERVICE:-asambleas-app}"
ROLLBACK_IMAGE_FILE="${ROLLBACK_IMAGE_FILE:-.last_asambleas_image}"

case "${1:-}" in
  "") ROLLBACK_IMAGE="" ;;
  */* | *@*) ROLLBACK_IMAGE="$1" ;;
  *) ROLLBACK_IMAGE="${IMAGE_NAME}:$1" ;;
esac

if [ -z "$ROLLBACK_IMAGE" ]; then
  log "Read saved rollback image"
  ROLLBACK_IMAGE="$(
    "$SSH_BIN" "$VPS_HOST" "cd $(printf '%q' "$COMPOSE_DIR") && cat $(printf '%q' "$ROLLBACK_IMAGE_FILE") 2>/dev/null || true"
  )"
  ROLLBACK_IMAGE="${ROLLBACK_IMAGE//$'\r'/}"
fi

if [ -z "$ROLLBACK_IMAGE" ]; then
  printf 'ERROR: no saved rollback image on the VPS; pass a tag: bash ./scripts/rollback.sh <tag>\n' >&2
  exit 1
fi

log "Rollback to: $ROLLBACK_IMAGE"

# Runs on the VPS; see the note on stdin in deploy.sh.
read -r -d '' REMOTE_SCRIPT <<'REMOTE' || true
set -euo pipefail

cd "$COMPOSE_DIR"
export ASAMBLEAS_IMAGE="$IMAGE"

echo "== Pull rollback image if missing =="
docker compose pull --policy missing "$APP_SERVICE" </dev/null

echo "== Recreate app container =="
docker compose up -d --no-deps "$APP_SERVICE" </dev/null

echo "== Wait for the app to be healthy =="
container_id="$(docker compose ps -q "$APP_SERVICE" </dev/null)"
status=missing
for _ in $(seq 1 40); do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container_id" 2>/dev/null || echo missing)"
  case "$status" in
    healthy | no-healthcheck | missing) break ;;
  esac
  sleep 3
done
if [ "$status" != healthy ]; then
  echo "ERROR: $APP_SERVICE is $status. Last logs:" >&2
  docker compose logs --tail 80 "$APP_SERVICE" </dev/null >&2 || true
  exit 1
fi
echo "    healthy"

echo "== Persist ASAMBLEAS_IMAGE in .env =="
line="ASAMBLEAS_IMAGE=$IMAGE"
if [ -f .env ] && grep -q '^ASAMBLEAS_IMAGE=' .env; then
  tmp="$(mktemp)"
  sed "s|^ASAMBLEAS_IMAGE=.*|$line|" .env >"$tmp"
  cat "$tmp" >.env
  rm -f "$tmp"
else
  if [ -s .env ] && [ -n "$(tail -c1 .env)" ]; then
    printf '\n' >>.env
  fi
  printf '%s\n' "$line" >>.env
fi
echo "    $line"
echo "== Remote rollback done =="
REMOTE

remote_env="$(printf '%q=%q ' \
  COMPOSE_DIR "$COMPOSE_DIR" \
  IMAGE "$ROLLBACK_IMAGE" \
  APP_SERVICE "$COMPOSE_APP_SERVICE")"

log_file="$(mktemp)"
trap 'rm -f "$log_file"' EXIT
"$SSH_BIN" "$VPS_HOST" "env ${remote_env}bash -se" <<<"$REMOTE_SCRIPT" | tee "$log_file"
if ! grep -qxF "== Remote rollback done ==" "$log_file"; then
  printf 'ERROR: the remote rollback stopped before its last step\n' >&2
  exit 1
fi

printf 'Rollback finished successfully: %s\n' "$ROLLBACK_IMAGE"
