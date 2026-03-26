#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./rvc-common.sh
source "$SCRIPT_DIR/rvc-common.sh"

launch_domain="gui/$(id -u)"

usage() {
  cat <<'EOF'
Usage:
  scripts/rvc-prod-launchagent.sh install [host|web|all] [--executor codex|claude-code|both]
  scripts/rvc-prod-launchagent.sh start [host|web|all]
  scripts/rvc-prod-launchagent.sh stop [host|web|all]
  scripts/rvc-prod-launchagent.sh restart [host|web|all] [--executor codex|claude-code|both]
  scripts/rvc-prod-launchagent.sh status [host|web|all]
  scripts/rvc-prod-launchagent.sh build [host|web|all]
  scripts/rvc-prod-launchagent.sh configure [--executor codex|claude-code|both]
EOF
}

prod_service_label() {
  case "$1" in
    host) printf 'com.remote-vibe-coding.host\n' ;;
    web) printf 'com.remote-vibe-coding.web\n' ;;
    *) rvc_die "Unknown prod service: $1" ;;
  esac
}

prod_service_port() {
  case "$1" in
    host) printf '8787\n' ;;
    web) printf '5173\n' ;;
    *) rvc_die "Unknown prod service: $1" ;;
  esac
}

prod_service_plist() {
  case "$1" in
    host) printf '%s\n' "$HOME/Library/LaunchAgents/com.remote-vibe-coding.host.plist" ;;
    web) printf '%s\n' "$HOME/Library/LaunchAgents/com.remote-vibe-coding.web.plist" ;;
    *) rvc_die "Unknown prod service: $1" ;;
  esac
}

prod_service_stdout_log() {
  case "$1" in
    host) printf '%s\n' "$HOME/Library/Logs/remote-vibe-coding.host.log" ;;
    web) printf '%s\n' "$HOME/Library/Logs/remote-vibe-coding.web.log" ;;
    *) rvc_die "Unknown prod service: $1" ;;
  esac
}

prod_service_stderr_log() {
  case "$1" in
    host) printf '%s\n' "$HOME/Library/Logs/remote-vibe-coding.host.error.log" ;;
    web) printf '%s\n' "$HOME/Library/Logs/remote-vibe-coding.web.error.log" ;;
    *) rvc_die "Unknown prod service: $1" ;;
  esac
}

prod_service_runner() {
  case "$1" in
    host) printf '%s\n' "$RVC_REPO_ROOT/scripts/run-host.sh" ;;
    web) printf '%s\n' "$RVC_REPO_ROOT/scripts/run-web.sh" ;;
    *) rvc_die "Unknown prod service: $1" ;;
  esac
}

prod_service_listener_signature() {
  case "$1" in
    host) printf '%s\n' "apps/host/dist/server.js" ;;
    web) printf '%s\n' "vite/bin/vite.js preview" ;;
    *) rvc_die "Unknown prod service: $1" ;;
  esac
}

launch_ref_for_service() {
  local service="$1"
  printf '%s/%s\n' "$launch_domain" "$(prod_service_label "$service")"
}

configure_prod_runtime() {
  local executor_mode="${1:-}"
  local resolved_mode

  resolved_mode="$(ensure_executor_mode_config prod "$executor_mode")"
  rvc_info "Stored prod executor mode: $resolved_mode"
  rvc_info "Runtime config: $(runtime_env_file prod)"
}

build_prod_service() {
  local service="$1"

  case "$service" in
    host)
      rvc_info "Building production host bundle"
      (
        cd "$RVC_REPO_ROOT"
        npm run build --workspace @rvc/host
      )
      ;;
    web)
      rvc_info "Building production web bundle with API base http://127.0.0.1:8787"
      (
        cd "$RVC_REPO_ROOT"
        VITE_API_BASE_URL="http://127.0.0.1:8787" npm run build --workspace @rvc/web
      )
      ;;
    *)
      rvc_die "Unknown prod service: $service"
      ;;
  esac
}

build_prod_target() {
  case "$1" in
    host)
      build_prod_service host
      ;;
    web)
      build_prod_service web
      ;;
    all)
      build_prod_service host
      build_prod_service web
      ;;
    *)
      rvc_die "Unsupported target: $1"
      ;;
  esac
}

write_prod_plist() {
  local service="$1"
  local plist_path label stdout_log stderr_log runner

  plist_path="$(prod_service_plist "$service")"
  label="$(prod_service_label "$service")"
  stdout_log="$(prod_service_stdout_log "$service")"
  stderr_log="$(prod_service_stderr_log "$service")"
  runner="$(prod_service_runner "$service")"

  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  backup_file_if_exists "$plist_path"

  cat > "$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${label}</string>

    <key>ProgramArguments</key>
    <array>
      <string>/usr/bin/caffeinate</string>
      <string>-s</string>
      <string>${runner}</string>
      <string>prod</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${RVC_REPO_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${RVC_DEFAULT_PATH}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${stdout_log}</string>

    <key>StandardErrorPath</key>
    <string>${stderr_log}</string>
  </dict>
</plist>
EOF

  plutil -lint "$plist_path" >/dev/null
  rvc_info "Wrote $(basename "$plist_path")"
}

launchagent_is_loaded() {
  local service="$1"
  launchctl print "$(launch_ref_for_service "$service")" >/dev/null 2>&1
}

start_prod_service() {
  local service="$1"
  local plist_path

  plist_path="$(prod_service_plist "$service")"
  [[ -f "$plist_path" ]] || rvc_die "Missing $(basename "$plist_path"); run install first"

  if launchagent_is_loaded "$service"; then
    launchctl kickstart -k "$(launch_ref_for_service "$service")"
  else
    launchctl bootstrap "$launch_domain" "$plist_path"
    launchctl kickstart -k "$(launch_ref_for_service "$service")"
  fi

  rvc_info "Started prod $service via LaunchAgent"
}

stop_prod_service() {
  local service="$1"
  local plist_path

  plist_path="$(prod_service_plist "$service")"
  if launchagent_is_loaded "$service"; then
    launchctl bootout "$launch_domain" "$plist_path"
    rvc_info "Stopped prod $service"
    return 0
  fi

  rvc_info "prod $service is not loaded"
}

restart_prod_service() {
  local service="$1"
  local plist_path

  plist_path="$(prod_service_plist "$service")"
  [[ -f "$plist_path" ]] || rvc_die "Missing $(basename "$plist_path"); run install first"

  if launchagent_is_loaded "$service"; then
    launchctl bootout "$launch_domain" "$plist_path"
  fi
  launchctl bootstrap "$launch_domain" "$plist_path"
  launchctl kickstart -k "$(launch_ref_for_service "$service")"
  rvc_info "Restarted prod $service via LaunchAgent"
}

status_prod_service() {
  local service="$1"
  local port listener_pid listener_signature

  printf 'prod %-4s label=%s\n' "$service" "$(prod_service_label "$service")"
  if launchagent_is_loaded "$service"; then
    launchctl print "$(launch_ref_for_service "$service")" \
      | sed -n -e 's/^[[:space:]]*state = /  state=/p' -e 's/^[[:space:]]*pid = /  pid=/p' -e 's/^[[:space:]]*last exit code = /  last_exit=/p'
  else
    printf '  state=not-loaded\n'
  fi

  port="$(prod_service_port "$service")"
  listener_pid="$(listening_pid_for_port "$port")"
  listener_signature="$(prod_service_listener_signature "$service")"
  if [[ -n "$listener_pid" ]]; then
    if pid_matches_signature "$listener_pid" "$listener_signature"; then
      printf '  listener pid=%s command=%s\n' "$listener_pid" "$(process_command "$listener_pid")"
    else
      printf '  port conflict pid=%s command=%s\n' "$listener_pid" "$(process_command "$listener_pid")"
    fi
  else
    printf '  listener=none port=%s\n' "$port"
  fi
}

install_prod_service() {
  local service="$1"

  write_prod_plist "$service"
  restart_prod_service "$service"
}

run_prod_for_target() {
  local action="$1"
  local target="$2"

  case "$target" in
    host)
      "${action}_prod_service" host
      ;;
    web)
      "${action}_prod_service" web
      ;;
    all)
      if [[ "$action" == "status" ]]; then
        status_prod_service host
        status_prod_service web
      else
        "${action}_prod_service" host
        "${action}_prod_service" web
      fi
      ;;
    *)
      rvc_die "Unsupported target: $target"
      ;;
  esac
}

action="${1:-install}"
shift || true
target="all"
executor_mode=""

if [[ "$action" == "--help" || "$action" == "-h" ]]; then
  usage
  exit 0
fi

if [[ $# -gt 0 && "${1:-}" != --* ]]; then
  target="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --executor)
      [[ $# -ge 2 ]] || rvc_die "--executor requires a value"
      executor_mode="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      rvc_die "Unknown argument: $1"
      ;;
  esac
done

case "$action" in
  install|start|stop|restart|status|build|configure)
    ;;
  *)
    usage
    rvc_die "Unsupported action: $action"
    ;;
esac

case "$target" in
  host|web|all)
    ;;
  *)
    usage
    rvc_die "Unsupported target: $target"
    ;;
esac

ensure_common_dirs

case "$action" in
  configure)
    configure_prod_runtime "$executor_mode"
    ;;
  build)
    build_prod_target "$target"
    ;;
  install)
    configure_prod_runtime "$executor_mode"
    build_prod_target "$target"
    run_prod_for_target install "$target"
    ;;
  start)
    run_prod_for_target start "$target"
    ;;
  stop)
    run_prod_for_target stop "$target"
    ;;
  restart)
    configure_prod_runtime "$executor_mode"
    run_prod_for_target restart "$target"
    ;;
  status)
    run_prod_for_target status "$target"
    ;;
esac
