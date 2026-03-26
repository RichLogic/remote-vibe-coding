#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./rvc-common.sh
source "$SCRIPT_DIR/rvc-common.sh"

profile="${1:-}"
case "$profile" in
  dev|prod)
    ;;
  *)
    rvc_die "Usage: $0 <dev|prod>"
    ;;
esac

ensure_common_dirs
load_runtime_env "$profile"

node_bin="$(command -v node || true)"
[[ -n "$node_bin" ]] || rvc_die "node is not available on PATH"

export HOST="${HOST:-127.0.0.1}"
export MONGODB_URL="${MONGODB_URL:-mongodb://127.0.0.1:27017/?directConnection=true}"
export MONGODB_DB_NAME="${MONGODB_DB_NAME:-remote_vibe_coding}"
export RVC_EXECUTOR_INIT="${RVC_EXECUTOR_INIT:-codex}"

if [[ "$profile" == "dev" ]]; then
  export NODE_ENV="development"
  export PORT="${PORT:-8788}"
  unset CLOUDFLARE_TUNNEL_TOKEN CLOUDFLARE_PUBLIC_URL CLOUDFLARE_TARGET_URL

  tsx_bin="$RVC_REPO_ROOT/node_modules/.bin/tsx"
  [[ -x "$tsx_bin" ]] || rvc_die "Missing tsx binary at $tsx_bin; run npm install first"
  cd "$RVC_REPO_ROOT"
  exec "$tsx_bin" watch "$RVC_REPO_ROOT/apps/host/src/server.ts"
fi

export NODE_ENV="production"
export PORT="${PORT:-8787}"

host_dist="$RVC_REPO_ROOT/apps/host/dist/server.js"
[[ -f "$host_dist" ]] || rvc_die "Missing $host_dist; run scripts/rvc-prod-launchagent.sh install first"

cd "$RVC_REPO_ROOT"
exec "$node_bin" "$host_dist"
