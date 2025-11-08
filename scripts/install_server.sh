#!/usr/bin/env bash
set -euo pipefail

# Mail API Proxy installer (Debian/Ubuntu)
# Usage example:
#   bash -c "$(wget -qO- https://raw.githubusercontent.com/<your-user>/<your-repo>/main/scripts/install_server.sh)" \
#     REPO_URL=https://github.com/<your-user>/<your-repo>.git BRANCH=main HTTP_PORT=8080

REPO_URL=${REPO_URL:-https://github.com/your-org/mail-api-proxy.git}
BRANCH=${BRANCH:-main}
INSTALL_DIR=${INSTALL_DIR:-/opt/mail-api-proxy}
HTTP_PORT=${HTTP_PORT:-8080}

echo "[+] Installer starting"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || return 1
}

run() {
  echo "> $*" >&2
  "$@"
}

ensure_root() {
  if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
      echo "[i] Using sudo to escalate"
      SUDO="sudo"
    else
      echo "[!] Please run as root or install sudo"
      exit 1
    fi
  else
    SUDO=""
  fi
}

detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID=${ID:-}
  else
    OS_ID="unknown"
  fi
}

install_deps_apt() {
  $SUDO apt-get update -y
  $SUDO apt-get install -y ca-certificates curl git gnupg lsb-release
}

install_docker() {
  if need_cmd docker; then
    echo "[i] Docker already installed"
  else
    echo "[+] Installing Docker (get.docker.com)"
    curl -fsSL https://get.docker.com | $SUDO sh
  fi
  if ! need_cmd docker; then
    echo "[!] Docker installation failed"
    exit 1
  fi

  if need_cmd systemctl; then
    $SUDO systemctl enable --now docker || true
  fi

  if docker compose version >/dev/null 2>&1; then
    echo "[i] Docker Compose plugin present"
  else
    echo "[!] docker compose plugin not found. Ensure Docker >= 20.10+ or install docker-compose-plugin"
    if [ "$OS_ID" = "ubuntu" ] || [ "$OS_ID" = "debian" ]; then
      $SUDO apt-get install -y docker-compose-plugin || true
    fi
  fi

  docker compose version >/dev/null 2>&1 || {
    echo "[!] docker compose still missing. Aborting."
    exit 1
  }
}

deploy() {
  echo "[+] Deploying to $INSTALL_DIR"
  $SUDO mkdir -p "$INSTALL_DIR"
  if [ ! -d "$INSTALL_DIR/.git" ]; then
    run $SUDO git clone --depth=1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  else
    echo "[i] Repo exists, pulling updates"
    run $SUDO git -C "$INSTALL_DIR" fetch --depth=1 origin "$BRANCH"
    run $SUDO git -C "$INSTALL_DIR" checkout "$BRANCH"
    run $SUDO git -C "$INSTALL_DIR" pull --ff-only
  fi

  # Ensure .env
  if [ ! -f "$INSTALL_DIR/.env" ]; then
    echo "[i] Creating .env from example"
    run $SUDO cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  fi

  # Helper to upsert KEY=VALUE in .env
  upsert_env() {
    key="$1"; val="$2"; envfile="$INSTALL_DIR/.env"
    esc_val=$(printf '%s' "$val" | sed -e 's/[&|]/\\&/g')
    if grep -qE "^${key}=" "$envfile"; then
      $SUDO sed -i -E "s|^${key}=.*|${key}=${esc_val}|" "$envfile"
    else
      printf '%s=%s\n' "$key" "$val" | $SUDO tee -a "$envfile" >/dev/null
    fi
  }

  # If provided as env vars to installer, write into .env
  for k in PORT HTTP_PORT TRUST_PROXY REQUEST_BODY_LIMIT CORS_ORIGINS BASIC_AUTH_USER BASIC_AUTH_PASS IP_ALLOWLIST \
           RATE_LIMIT_WINDOW_MS RATE_LIMIT_MAX IDEMPOTENCY_TTL_SECONDS ENABLE_METRICS LOG_LEVEL SMTP_ALLOWED_MODES \
           SMTP_CONNECTION_TIMEOUT_MS SMTP_GREETING_TIMEOUT_MS SMTP_SOCKET_TIMEOUT_MS MAIL_SEND_TIMEOUT_MS; do
    v="${!k-}"
    if [ -n "$v" ]; then
      upsert_env "$k" "$v"
    fi
  done

  # Ensure HTTP_PORT is set at least to default
  if ! grep -q "^HTTP_PORT=" "$INSTALL_DIR/.env"; then
    upsert_env HTTP_PORT "$HTTP_PORT"
  fi

  echo "[+] Starting via docker compose"
  (cd "$INSTALL_DIR" && run $SUDO docker compose up -d --build)
}

ensure_root
detect_os

case "$OS_ID" in
  ubuntu|debian)
    install_deps_apt
    ;;
  *)
    echo "[!] Unsupported OS ($OS_ID). Proceeding, but Docker install may fail."
    ;;
esac

install_docker
deploy

echo "[✓] Deployed. Check: docker compose -f $INSTALL_DIR/docker-compose.yml ps"
echo "[i] Health: curl http://localhost:${HTTP_PORT}/health"
