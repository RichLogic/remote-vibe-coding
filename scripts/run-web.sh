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

if [[ "$profile" == "dev" ]]; then
  export NODE_ENV="development"
  host_port="${RVC_API_PORT:-8788}"
  web_port="${RVC_WEB_PORT:-5174}"
  unset CLOUDFLARE_TUNNEL_TOKEN CLOUDFLARE_PUBLIC_URL CLOUDFLARE_TARGET_URL

  cd "$RVC_REPO_ROOT"
  exec "$node_bin" "$RVC_REPO_ROOT/apps/web/scripts/dev.mjs" \
    --api-port "$host_port" \
    --host 127.0.0.1 \
    --port "$web_port" \
    --strictPort
fi

export NODE_ENV="production"
web_port="${RVC_WEB_PORT:-5173}"

web_dist="$RVC_REPO_ROOT/apps/web/dist/index.html"
[[ -f "$web_dist" ]] || rvc_die "Missing $web_dist; run scripts/rvc-prod-launchagent.sh install first"

cd "$RVC_REPO_ROOT/apps/web"
exec "$node_bin" "$RVC_REPO_ROOT/node_modules/vite/bin/vite.js" preview \
  --host 127.0.0.1 \
  --port "$web_port" \
  --strictPort
