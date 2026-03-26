#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./rvc-common.sh
source "$SCRIPT_DIR/rvc-common.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/rvc-dev.sh start [host|web|all] [--executor codex|claude-code|both]
  scripts/rvc-dev.sh stop [host|web|all]
  scripts/rvc-dev.sh restart [host|web|all] [--executor codex|claude-code|both]
  scripts/rvc-dev.sh status [host|web|all]
  scripts/rvc-dev.sh configure [--executor codex|claude-code|both]
EOF
}

dev_service_port() {
  case "$1" in
    host) printf '8788\n' ;;
    web) printf '5174\n' ;;
    *) rvc_die "Unknown dev service: $1" ;;
  esac
}

dev_service_pid_file() {
  case "$1" in
    host) printf '%s\n' "$RVC_RUN_DIR/dev-host.pid" ;;
    web) printf '%s\n' "$RVC_RUN_DIR/dev-web.pid" ;;
    *) rvc_die "Unknown dev service: $1" ;;
  esac
}

dev_service_log_file() {
  case "$1" in
    host) printf '%s\n' "$RVC_LOG_DIR/dev-host.log" ;;
    web) printf '%s\n' "$RVC_LOG_DIR/dev-web.log" ;;
    *) rvc_die "Unknown dev service: $1" ;;
  esac
}

dev_service_pid_signature() {
  case "$1" in
    host) printf '%s\n' "apps/host/src/server.ts" ;;
    web) printf '%s\n' "apps/web/scripts/dev.mjs" ;;
    *) rvc_die "Unknown dev service: $1" ;;
  esac
}

dev_service_listener_signature() {
  case "$1" in
    host) printf '%s\n' "apps/host/src/server.ts" ;;
    web) printf '%s\n' "vite/bin/vite.js" ;;
    *) rvc_die "Unknown dev service: $1" ;;
  esac
}

dev_service_runner() {
  case "$1" in
    host) printf '%s\n' "$RVC_REPO_ROOT/scripts/run-host.sh" ;;
    web) printf '%s\n' "$RVC_REPO_ROOT/scripts/run-web.sh" ;;
    *) rvc_die "Unknown dev service: $1" ;;
  esac
}

managed_pid_from_file() {
  local service="$1"
  local pid_file pid signature

  pid_file="$(dev_service_pid_file "$service")"
  signature="$(dev_service_pid_signature "$service")"
  pid="$(read_pid_file "$pid_file" 2>/dev/null || true)"

  if [[ -z "$pid" ]]; then
    return 1
  fi
  if pid_is_running "$pid" && pid_matches_signature "$pid" "$signature"; then
    printf '%s\n' "$pid"
    return 0
  fi

  rm -f "$pid_file"
  return 1
}

configure_dev_runtime() {
  local executor_mode="${1:-}"
  local resolved_mode

  resolved_mode="$(ensure_executor_mode_config dev "$executor_mode")"
  rvc_info "Stored dev executor mode: $resolved_mode"
  rvc_info "Runtime config: $(runtime_env_file dev)"
}

start_dev_service() {
  local service="$1"
  local port pid_file log_file pid_signature listener_signature runner managed_pid listener_pid listener_command pid

  port="$(dev_service_port "$service")"
  pid_file="$(dev_service_pid_file "$service")"
  log_file="$(dev_service_log_file "$service")"
  pid_signature="$(dev_service_pid_signature "$service")"
  listener_signature="$(dev_service_listener_signature "$service")"
  runner="$(dev_service_runner "$service")"

  managed_pid="$(managed_pid_from_file "$service" || true)"
  if [[ -n "$managed_pid" ]]; then
    rvc_info "dev $service already running (pid $managed_pid, port $port)"
    return 0
  fi

  listener_pid="$(listening_pid_for_port "$port")"
  if [[ -n "$listener_pid" ]]; then
    listener_command="$(process_command "$listener_pid")"
    if pid_matches_signature "$listener_pid" "$listener_signature"; then
      rvc_die "dev $service already has an unmanaged listener on port $port (pid $listener_pid: $listener_command)"
    fi
    rvc_die "Port $port is already used by pid $listener_pid: $listener_command"
  fi

  mkdir -p "$(dirname "$pid_file")" "$(dirname "$log_file")"
  : > "$log_file"
  nohup "$runner" dev >> "$log_file" 2>&1 &
  pid=$!
  printf '%s\n' "$pid" > "$pid_file"

  if ! wait_for_matching_listener "$port" "$listener_signature" 120; then
    if pid_is_running "$pid" && pid_matches_signature "$pid" "$pid_signature"; then
      kill "$pid" 2>/dev/null || true
      wait_for_pid_exit "$pid" 40 || kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
    rvc_die "dev $service failed to bind port $port; see $log_file"
  fi

  rvc_info "Started dev $service on 127.0.0.1:$port"
}

stop_dev_service() {
  local service="$1"
  local port pid_file pid_signature listener_signature managed_pid listener_pid

  port="$(dev_service_port "$service")"
  pid_file="$(dev_service_pid_file "$service")"
  pid_signature="$(dev_service_pid_signature "$service")"
  listener_signature="$(dev_service_listener_signature "$service")"
  managed_pid="$(managed_pid_from_file "$service" || true)"

  if [[ -z "$managed_pid" ]]; then
    listener_pid="$(listening_pid_for_port "$port")"
    if [[ -n "$listener_pid" ]] && pid_matches_signature "$listener_pid" "$listener_signature"; then
      rvc_die "dev $service is listening on port $port without a managed pidfile; refusing to kill by port"
    fi
    rvc_info "dev $service is not running"
    rm -f "$pid_file"
    return 0
  fi

  if ! pid_matches_signature "$managed_pid" "$pid_signature"; then
    rvc_die "Refusing to stop dev $service because pid $managed_pid no longer matches the expected command"
  fi

  kill "$managed_pid"
  if ! wait_for_pid_exit "$managed_pid" 60; then
    kill -9 "$managed_pid"
    wait_for_pid_exit "$managed_pid" 20 || rvc_die "Failed to stop dev $service pid $managed_pid"
  fi

  rm -f "$pid_file"
  rvc_info "Stopped dev $service"
}

status_dev_service() {
  local service="$1"
  local port pid_file pid_signature listener_signature managed_pid listener_pid

  port="$(dev_service_port "$service")"
  pid_file="$(dev_service_pid_file "$service")"
  pid_signature="$(dev_service_pid_signature "$service")"
  listener_signature="$(dev_service_listener_signature "$service")"
  managed_pid="$(managed_pid_from_file "$service" || true)"
  listener_pid="$(listening_pid_for_port "$port")"

  if [[ -n "$managed_pid" ]]; then
    printf 'dev %-4s managed pid=%s port=%s\n' "$service" "$managed_pid" "$port"
  else
    printf 'dev %-4s managed pid=none port=%s\n' "$service" "$port"
  fi

  if [[ -n "$listener_pid" ]]; then
    if pid_matches_signature "$listener_pid" "$listener_signature"; then
      printf '  listener pid=%s command=%s\n' "$listener_pid" "$(process_command "$listener_pid")"
    else
      printf '  port conflict pid=%s command=%s\n' "$listener_pid" "$(process_command "$listener_pid")"
    fi
  else
    printf '  listener=none\n'
  fi

  if [[ -f "$pid_file" && -z "$managed_pid" ]]; then
    printf '  stale pidfile=%s\n' "$pid_file"
  fi
}

run_for_target() {
  local action="$1"
  local target="$2"

  case "$target" in
    host)
      "${action}_dev_service" host
      ;;
    web)
      "${action}_dev_service" web
      ;;
    all)
      if [[ "$action" == "start" ]]; then
        start_dev_service host
        start_dev_service web
      elif [[ "$action" == "stop" ]]; then
        stop_dev_service web
        stop_dev_service host
      elif [[ "$action" == "status" ]]; then
        status_dev_service host
        status_dev_service web
      else
        rvc_die "Unsupported action dispatch: $action"
      fi
      ;;
    *)
      rvc_die "Unsupported target: $target"
      ;;
  esac
}

action="${1:-start}"
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
  start|stop|restart|status|configure)
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
    configure_dev_runtime "$executor_mode"
    ;;
  start)
    configure_dev_runtime "$executor_mode"
    run_for_target start "$target"
    ;;
  stop)
    run_for_target stop "$target"
    ;;
  restart)
    configure_dev_runtime "$executor_mode"
    run_for_target stop "$target"
    run_for_target start "$target"
    ;;
  status)
    run_for_target status "$target"
    ;;
esac
