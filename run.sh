#!/usr/bin/env bash

set -euo pipefail

SKIP_INSTALL=false

for arg in "$@"; do
  case "$arg" in
    --skip-install)
      SKIP_INSTALL=true
      ;;
    *)
      echo "Uso: ./start-app.sh [--skip-install]"
      exit 1
      ;;
  esac
done

log_step() {
  printf '==> %s\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Erro: comando "%s" nao encontrado no PATH.\n' "$1" >&2
    exit 1
  fi
}

find_python() {
  if command -v python3 >/dev/null 2>&1; then
    command -v python3
    return
  fi

  if command -v python >/dev/null 2>&1; then
    command -v python
    return
  fi

  printf 'Erro: Python 3 nao encontrado no PATH.\n' >&2
  exit 1
}

is_supported_node_version() {
  local version
  version="$1"
  local major minor patch

  if [[ ! "$version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    return 1
  fi

  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  patch="${BASH_REMATCH[3]}"

  if (( major > 22 )); then
    return 0
  fi

  if (( major == 22 )); then
    if (( minor > 12 )); then
      return 0
    fi

    if (( minor == 12 && patch >= 0 )); then
      return 0
    fi
  fi

  if (( major == 20 )); then
    if (( minor > 19 )); then
      return 0
    fi

    if (( minor == 19 && patch >= 0 )); then
      return 0
    fi
  fi

  return 1
}

cleanup() {
  local exit_code
  exit_code=$?

  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
  fi

  if [[ -n "${FRONTEND_PID:-}" ]] && kill -0 "$FRONTEND_PID" >/dev/null 2>&1; then
    kill "$FRONTEND_PID" >/dev/null 2>&1 || true
  fi

  wait >/dev/null 2>&1 || true
  exit "$exit_code"
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
REQUIREMENTS_FILE="$BACKEND_DIR/requirements.txt"
VENV_DIR="$BACKEND_DIR/.venv"
VENV_PYTHON="$VENV_DIR/bin/python"
PYTHON_BIN="$(find_python)"

if [[ ! -f "$REQUIREMENTS_FILE" ]]; then
  printf 'Erro: arquivo de requisitos nao encontrado em %s.\n' "$REQUIREMENTS_FILE" >&2
  exit 1
fi

require_command npm
require_command node

NODE_VERSION="$(node --version)"
if ! is_supported_node_version "$NODE_VERSION"; then
  printf 'Erro: Node.js %s detectado. Este frontend precisa de Node 20.19+ ou 22.12+.\n' "$NODE_VERSION" >&2
  exit 1
fi

if [[ ! -x "$VENV_PYTHON" ]]; then
  log_step "Criando ambiente virtual em backend/.venv"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

log_step "Ativando ambiente virtual"
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

if [[ "$SKIP_INSTALL" != true ]]; then
  log_step "Atualizando o pip do backend"
  "$VENV_PYTHON" -m pip install --upgrade pip

  log_step "Instalando dependencias do backend"
  "$VENV_PYTHON" -m pip install -r "$REQUIREMENTS_FILE"

  log_step "Instalando dependencias do frontend"
  (
    cd "$FRONTEND_DIR"
    npm install
  )
fi

trap cleanup EXIT INT TERM

log_step "Subindo backend em http://localhost:8081"
(
  cd "$BACKEND_DIR"
  exec "$VENV_PYTHON" -m uvicorn main:app --reload --port 8081
) &
BACKEND_PID=$!

log_step "Subindo frontend em http://localhost:3001"
(
  cd "$FRONTEND_DIR"
  exec npm run dev -- --host 0.0.0.0
) &
FRONTEND_PID=$!

printf '\nBackend:  http://localhost:8081\n'
printf 'Frontend: http://localhost:3001\n\n'
printf 'Para pular reinstalacoes futuras, use: ./start-app.sh --skip-install\n\n'

wait -n "$BACKEND_PID" "$FRONTEND_PID"