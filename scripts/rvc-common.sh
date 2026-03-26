#!/usr/bin/env bash
set -euo pipefail

RVC_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RVC_REPO_ROOT="$(cd "$RVC_SCRIPT_DIR/.." && pwd)"
RVC_STATE_DIR="$RVC_REPO_ROOT/.rvc"
RVC_RUN_DIR="$RVC_STATE_DIR/run"
RVC_LOG_DIR="$RVC_STATE_DIR/logs"
RVC_CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/remote-vibe-coding"
RVC_RUNTIME_CONFIG_DIR="$RVC_CONFIG_ROOT/runtime"
RVC_DEFAULT_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

rvc_info() {
  printf '[rvc] %s\n' "$*"
}

rvc_warn() {
  printf '[rvc] %s\n' "$*" >&2
}

rvc_die() {
  rvc_warn "$*"
  exit 1
}

ensure_common_dirs() {
  mkdir -p "$RVC_RUN_DIR" "$RVC_LOG_DIR" "$RVC_RUNTIME_CONFIG_DIR"
}

runtime_env_file() {
  case "${1:-}" in
    dev)
      printf '%s\n' "$RVC_RUNTIME_CONFIG_DIR/dev-launch.env"
      ;;
    prod)
      printf '%s\n' "$RVC_RUNTIME_CONFIG_DIR/prod-launch.env"
      ;;
    *)
      rvc_die "Unknown runtime profile: ${1:-<empty>}"
      ;;
  esac
}

canonical_executor_mode() {
  case "${1:-}" in
    codex)
      printf 'codex\n'
      ;;
    claude|claude-code|claude_code)
      printf 'claude-code\n'
      ;;
    both|all)
      printf 'both\n'
      ;;
    *)
      return 1
      ;;
  esac
}

prompt_executor_mode() {
  local current_mode="${1:-both}"
  local choice=""

  while true; do
    printf 'Select executor initialization mode:\n'
    printf '  1) codex\n'
    printf '  2) claude-code\n'
    printf '  3) both\n'
    printf 'Press Enter for [%s]: ' "$current_mode"
    read -r choice
    case "$choice" in
      "")
        printf '%s\n' "$current_mode"
        return 0
        ;;
      1|codex)
        printf 'codex\n'
        return 0
        ;;
      2|claude|claude-code|claude_code)
        printf 'claude-code\n'
        return 0
        ;;
      3|both|all)
        printf 'both\n'
        return 0
        ;;
      *)
        rvc_warn "Invalid choice: $choice"
        ;;
    esac
  done
}

set_env_var_in_file() {
  local file_path="$1"
  local key="$2"
  local value="$3"
  local temp_file="${file_path}.tmp.$$"

  mkdir -p "$(dirname "$file_path")"
  if [[ -f "$file_path" ]]; then
    grep -vE "^${key}=" "$file_path" > "$temp_file" || true
  else
    : > "$temp_file"
  fi

  if [[ ! -s "$temp_file" ]]; then
    printf '# remote-vibe-coding runtime config\n' > "$temp_file"
  fi

  printf '%s=%s\n' "$key" "$value" >> "$temp_file"
  mv "$temp_file" "$file_path"
}

ensure_executor_mode_config() {
  local profile="$1"
  local requested_mode="${2:-}"
  local env_file
  local current_mode
  local resolved_mode

  env_file="$(runtime_env_file "$profile")"
  current_mode="$(grep '^RVC_EXECUTOR_INIT=' "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
  current_mode="${current_mode:-both}"

  if [[ -n "$requested_mode" ]]; then
    resolved_mode="$(canonical_executor_mode "$requested_mode")" \
      || rvc_die "Unsupported executor mode: $requested_mode"
  elif [[ ! -f "$env_file" ]]; then
    resolved_mode="$(prompt_executor_mode "$current_mode")"
  else
    resolved_mode="$current_mode"
  fi

  set_env_var_in_file "$env_file" "RVC_EXECUTOR_INIT" "$resolved_mode"
  printf '%s\n' "$resolved_mode"
}

load_runtime_env() {
  local profile="$1"
  local env_file

  env_file="$(runtime_env_file "$profile")"
  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi

  export PATH="$RVC_DEFAULT_PATH${PATH:+:$PATH}"
}

read_pid_file() {
  [[ -f "$1" ]] || return 1
  tr -d '[:space:]' < "$1"
}

pid_is_running() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

process_command() {
  local pid="$1"
  ps -p "$pid" -o command= 2>/dev/null | sed 's/^[[:space:]]*//'
}

pid_matches_signature() {
  local pid="$1"
  local signature="$2"
  local command_line

  command_line="$(process_command "$pid")"
  [[ -n "$command_line" && "$command_line" == *"$signature"* ]]
}

listening_pid_for_port() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n1 || true
}

wait_for_pid_exit() {
  local pid="$1"
  local attempts="${2:-40}"
  local attempt=0

  while (( attempt < attempts )); do
    if ! pid_is_running "$pid"; then
      return 0
    fi
    sleep 0.25
    (( attempt += 1 ))
  done

  return 1
}

wait_for_matching_listener() {
  local port="$1"
  local signature="$2"
  local attempts="${3:-40}"
  local attempt=0
  local listener_pid=""

  while (( attempt < attempts )); do
    listener_pid="$(listening_pid_for_port "$port")"
    if [[ -n "$listener_pid" ]] && pid_matches_signature "$listener_pid" "$signature"; then
      return 0
    fi
    sleep 0.25
    (( attempt += 1 ))
  done

  return 1
}

backup_file_if_exists() {
  local file_path="$1"
  if [[ -f "$file_path" ]]; then
    cp "$file_path" "${file_path}.bak-$(date +%Y%m%d-%H%M%S)"
  fi
}
