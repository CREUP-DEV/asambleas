#!/usr/bin/env bash
# Clones production into the local development environment, replacing what
# is there: the `asambleas` database and the uploaded PDFs and images.
#
# In order:
#   1. Backs up the local database (backups/local-<date>.dump) and the local
#      uploads (backups/local-uploads-<date>.tar.gz).
#   2. Dumps the production database over SSH (backups/prod-<date>.dump,
#      `pg_dump -Fc` inside its postgresql container) and packs its uploads
#      (backups/prod-uploads-<date>.tar.gz).
#   3. Recreates the local database empty and restores the dump into it.
#      Never `pg_restore --clean` over the old one: tables of migrations not
#      deployed yet would stay and `db:migrate` would fail to create them.
#   4. Replaces the local uploads with production's.
#   5. Deletes every session (they are production's) and runs
#      `pnpm db:migrate` for the migrations not deployed yet.
#
# Settings come from the local .env, shared with scripts/deploy.sh: VPS_HOST,
# COMPOSE_DIR, REMOTE_DIR, COMPOSE_POSTGRES_SERVICE, DEPLOY_DB_NAME and
# DEPLOY_DB_USER for production; POSTGRES_USER, POSTGRES_DB and
# UPLOAD_STORAGE_DIR for the local side. No password is needed: both
# pg_dump and the restore run inside their containers.
#
# What it brings is personal data (emails, IPs and user agents in the
# activity log, what each account read): backups/ is ignored by git, and
# the dumps stay only on this machine.
#
# Usage: bash ./scripts/clone-prod-db.sh [--skip-uploads] [--skip-migrate]
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash ./scripts/clone-prod-db.sh                 clone the database and the uploads
  bash ./scripts/clone-prod-db.sh --skip-uploads  clone only the database
  bash ./scripts/clone-prod-db.sh --skip-migrate  do not run pnpm db:migrate afterwards
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

# Same as deploy.sh: under WSL the Linux ssh lacks Windows' keys and aliases.
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

# Refuses an empty or truncated file: even an empty database dumps a header.
require_size() {
  local file="$1" minimum="$2" what="$3"
  if [ "$(wc -c <"$file")" -lt "$minimum" ]; then
    printf 'ERROR: %s looks empty or truncated (%s); nothing was replaced\n' "$what" "$file" >&2
    exit 1
  fi
}

SKIP_UPLOADS=false
SKIP_MIGRATE=false
for arg in "$@"; do
  case "$arg" in
    --skip-uploads) SKIP_UPLOADS=true ;;
    --skip-migrate) SKIP_MIGRATE=true ;;
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

cd "$(dirname "${BASH_SOURCE[0]}")/.."
load_env_file ".env"

: "${VPS_HOST:?ERROR: VPS_HOST is required in .env (as for deploy.sh)}"
: "${COMPOSE_DIR:?ERROR: COMPOSE_DIR is required in .env (as for deploy.sh)}"
: "${POSTGRES_USER:?ERROR: POSTGRES_USER is required in .env}"
: "${POSTGRES_DB:?ERROR: POSTGRES_DB is required in .env}"

require_command docker
require_command tar
resolve_ssh_bin

REMOTE_DIR="${REMOTE_DIR:-${COMPOSE_DIR}/asambleas}"
REMOTE_UPLOADS="${REMOTE_DIR}/data/uploads"
COMPOSE_POSTGRES_SERVICE="${COMPOSE_POSTGRES_SERVICE:-postgresql}"
PROD_DB_NAME="${DEPLOY_DB_NAME:-asambleas}"
PROD_DB_USER="${DEPLOY_DB_USER:-asambleas}"
LOCAL_DB_SERVICE="${LOCAL_DB_SERVICE:-postgres}"
LOCAL_UPLOADS="${UPLOAD_STORAGE_DIR:-private/uploads/documents}"
BACKUP_DIR="backups"
STAMP="$(date +%Y%m%d-%H%M%S)"

if ! docker compose exec -T "$LOCAL_DB_SERVICE" true </dev/null 2>/dev/null; then
  printf "ERROR: the local '%s' container is not running (docker compose up -d)\n" "$LOCAL_DB_SERVICE" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
umask 077

local_psql() {
  docker compose exec -T "$LOCAL_DB_SERVICE" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$@"
}

log "Back up the local database"
LOCAL_DUMP="$BACKUP_DIR/local-$STAMP.dump"
docker compose exec -T "$LOCAL_DB_SERVICE" pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" </dev/null >"$LOCAL_DUMP"
echo "    $LOCAL_DUMP"

if [ "$SKIP_UPLOADS" != true ] && [ -d "$LOCAL_UPLOADS" ]; then
  log "Back up the local uploads"
  LOCAL_UPLOADS_BACKUP="$BACKUP_DIR/local-uploads-$STAMP.tar.gz"
  tar -C "$LOCAL_UPLOADS" -czf "$LOCAL_UPLOADS_BACKUP" .
  echo "    $LOCAL_UPLOADS_BACKUP"
fi

log "Dump the production database ($VPS_HOST)"
PROD_DUMP="$BACKUP_DIR/prod-$STAMP.dump"
printf -v remote_dump 'cd %q && docker compose exec -T %q pg_dump -U %q -Fc %q' \
  "$COMPOSE_DIR" "$COMPOSE_POSTGRES_SERVICE" "$PROD_DB_USER" "$PROD_DB_NAME"
"$SSH_BIN" -o ConnectTimeout=10 "$VPS_HOST" "$remote_dump" </dev/null >"$PROD_DUMP"
require_size "$PROD_DUMP" 1024 "the production dump"
echo "    $PROD_DUMP"

if [ "$SKIP_UPLOADS" != true ]; then
  log "Pack the production uploads"
  PROD_UPLOADS="$BACKUP_DIR/prod-uploads-$STAMP.tar.gz"
  printf -v remote_tar 'tar -C %q -czf - .' "$REMOTE_UPLOADS"
  "$SSH_BIN" -o ConnectTimeout=10 "$VPS_HOST" "$remote_tar" </dev/null >"$PROD_UPLOADS"
  require_size "$PROD_UPLOADS" 20 "the production uploads"
  echo "    $PROD_UPLOADS"
fi

log "Recreate the local database $POSTGRES_DB"
# WITH (FORCE) closes the connections a running dev server holds.
printf -v drop_sql 'DROP DATABASE IF EXISTS "%s" WITH (FORCE)' "$POSTGRES_DB"
printf -v create_sql 'CREATE DATABASE "%s" OWNER "%s"' "$POSTGRES_DB" "$POSTGRES_USER"
local_psql -d postgres -c "$drop_sql" -c "$create_sql" </dev/null

log "Restore the production dump"
# Owners and grants are production's role; locally everything is ours.
if ! docker compose exec -T "$LOCAL_DB_SERVICE" pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --no-owner --no-privileges --exit-on-error <"$PROD_DUMP"; then
  printf 'ERROR: the restore failed. The local database before it is in %s:\n' "$LOCAL_DUMP" >&2
  printf '  docker compose exec -T %s pg_restore -U %s -d %s --clean --if-exists --no-owner < %s\n' \
    "$LOCAL_DB_SERVICE" "$POSTGRES_USER" "$POSTGRES_DB" "$LOCAL_DUMP" >&2
  exit 1
fi

log "Delete production's sessions"
local_psql -d "$POSTGRES_DB" -c 'DELETE FROM sessions' </dev/null

if [ "$SKIP_UPLOADS" != true ]; then
  log "Replace the local uploads"
  mkdir -p "$LOCAL_UPLOADS"
  find "$LOCAL_UPLOADS" -mindepth 1 -delete
  tar -C "$LOCAL_UPLOADS" -xzf "$PROD_UPLOADS"
  echo "    $LOCAL_UPLOADS"
fi

if [ "$SKIP_MIGRATE" != true ]; then
  log "Apply the migrations not deployed yet"
  require_command pnpm
  pnpm db:migrate </dev/null
fi

log "Done"
echo "    Local database before: $LOCAL_DUMP"
echo "    Production dump:       $PROD_DUMP"
if [ "$SKIP_UPLOADS" != true ]; then
  echo "    Production uploads:    $PROD_UPLOADS"
fi
echo "Sign in again: production's sessions were deleted."
