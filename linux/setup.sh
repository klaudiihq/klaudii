#!/bin/bash
set -euo pipefail

# =========================================
#  Klaudii — Linux Installer
#  curl -fsSL https://klaudii.com/setup.sh | bash
# =========================================

KLAUDII_DIR="$HOME/.klaudii"
APP_DIR="$KLAUDII_DIR/app"
BIN_DIR="$KLAUDII_DIR/bin"
LOGS_DIR="$KLAUDII_DIR/logs"
DATA_DIR="$KLAUDII_DIR/data"
SYSTEMD_DIR="$HOME/.config/systemd/user"
REPO="https://github.com/klaudiihq/klaudii.git"
NODE_MIN=20
TTYD_VERSION="1.7.7"

# --- Colors ---
PURPLE='\033[0;35m'
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m'

# --- Flags ---
NO_GEMINI=false
for arg in "$@"; do
  case "$arg" in
    --no-gemini) NO_GEMINI=true ;;
    --help|-h)
      echo "Usage: setup.sh [--no-gemini]"
      echo "  --no-gemini  Skip Gemini CLI installation"
      exit 0
      ;;
  esac
done

# --- Helpers ---
step=0
total=7

step_header() {
  step=$((step + 1))
  echo ""
  echo -e "${BOLD}[$step/$total] $1${NC}"
}

ok()   { echo -e "      ${GREEN}✓${NC} $1"; }
info() { echo -e "      → $1"; }
fail() { echo -e "      ${RED}✗${NC} $1"; exit 1; }

# --- Banner ---
echo ""
echo -e "${PURPLE}${BOLD}  Klaudii Setup${NC}"
echo -e "  ${DIM}The Operating System for AI-Assisted Development${NC}"

# --- Detect distro ---
detect_pkg_manager() {
  if command -v apt-get &>/dev/null; then
    echo "apt"
  elif command -v dnf &>/dev/null; then
    echo "dnf"
  elif command -v yum &>/dev/null; then
    echo "yum"
  else
    echo "unknown"
  fi
}

PKG_MANAGER=$(detect_pkg_manager)

# Pretty name for display
if [ -f /etc/os-release ]; then
  DISTRO_NAME=$(. /etc/os-release && echo "$PRETTY_NAME")
else
  DISTRO_NAME="Linux"
fi
echo -e "  ${DIM}Detected: $DISTRO_NAME ($PKG_MANAGER)${NC}"

if [ "$PKG_MANAGER" = "unknown" ]; then
  fail "Unsupported package manager. Need apt, dnf, or yum."
fi

# --- Helper: install system package ---
pkg_install() {
  case "$PKG_MANAGER" in
    apt) sudo apt-get install -y -qq "$@" ;;
    dnf) sudo dnf install -y -q "$@" ;;
    yum) sudo yum install -y -q "$@" ;;
  esac
}

# =============================================================
#  Step 1: System packages (tmux, git, gcc/make, gh)
# =============================================================
step_header "Installing system packages..."

NEED_PKGS=()

# tmux
if ! command -v tmux &>/dev/null; then
  NEED_PKGS+=(tmux)
fi

# git
if ! command -v git &>/dev/null; then
  NEED_PKGS+=(git)
fi

# Build tools (needed for better-sqlite3 native compilation)
if ! command -v gcc &>/dev/null || ! command -v make &>/dev/null; then
  case "$PKG_MANAGER" in
    apt) NEED_PKGS+=(build-essential) ;;
    dnf|yum) NEED_PKGS+=(gcc gcc-c++ make) ;;
  esac
fi

# Python3 (needed by node-gyp for native modules)
if ! command -v python3 &>/dev/null; then
  NEED_PKGS+=(python3)
fi

# curl (needed for later steps)
if ! command -v curl &>/dev/null; then
  NEED_PKGS+=(curl)
fi

if [ ${#NEED_PKGS[@]} -gt 0 ]; then
  info "sudo required for: ${NEED_PKGS[*]}"
  case "$PKG_MANAGER" in
    apt) sudo apt-get update -qq ;;
  esac
  pkg_install "${NEED_PKGS[@]}"
fi

ok "tmux $(tmux -V 2>/dev/null || echo 'installed')"
ok "git $(git --version 2>/dev/null | awk '{print $3}')"
ok "build tools ready"

# GitHub CLI (gh) — add repo first if not installed
if ! command -v gh &>/dev/null; then
  info "Installing GitHub CLI..."
  case "$PKG_MANAGER" in
    apt)
      sudo mkdir -p /etc/apt/keyrings
      curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
      sudo apt-get update -qq
      sudo apt-get install -y -qq gh
      ;;
    dnf)
      sudo dnf install -y -q 'dnf-command(config-manager)'
      sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo
      sudo dnf install -y -q gh
      ;;
    yum)
      sudo yum-config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo
      sudo yum install -y -q gh
      ;;
  esac
fi
ok "gh $(gh --version 2>/dev/null | head -1 | awk '{print $3}')"

# =============================================================
#  Step 2: Node.js
# =============================================================
step_header "Checking Node.js..."

install_node() {
  info "Installing Node.js $NODE_MIN via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MIN}.x | sudo -E bash -
  pkg_install nodejs
}

if command -v node &>/dev/null; then
  NODE_VER=$(node -e "console.log(process.versions.node.split('.')[0])")
  if [ "$NODE_VER" -ge "$NODE_MIN" ]; then
    ok "Node.js $(node --version) already installed"
  else
    info "Node.js $(node --version) too old (need $NODE_MIN+)"
    install_node
  fi
else
  install_node
fi

# Verify npm is available
if ! command -v npm &>/dev/null; then
  fail "npm not found after Node.js install"
fi
ok "npm $(npm --version)"

# =============================================================
#  Step 3: ttyd
# =============================================================
step_header "Installing ttyd..."

mkdir -p "$BIN_DIR"

if command -v ttyd &>/dev/null; then
  ok "ttyd already installed ($(ttyd --version 2>&1 | head -1))"
elif [ -x "$BIN_DIR/ttyd" ]; then
  ok "ttyd already installed at $BIN_DIR/ttyd"
else
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  TTYD_ARCH="x86_64" ;;
    aarch64) TTYD_ARCH="aarch64" ;;
    arm64)   TTYD_ARCH="aarch64" ;;
    *)       fail "Unsupported architecture: $ARCH" ;;
  esac

  TTYD_URL="https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${TTYD_ARCH}"
  info "Downloading ttyd ${TTYD_VERSION} for ${TTYD_ARCH}..."
  curl -fsSL -o "$BIN_DIR/ttyd" "$TTYD_URL"
  chmod +x "$BIN_DIR/ttyd"
  ok "ttyd installed at $BIN_DIR/ttyd"
fi

# =============================================================
#  Step 4: Claude Code CLI
# =============================================================
step_header "Installing Claude Code CLI..."

if command -v claude &>/dev/null; then
  ok "Claude Code already installed ($(claude --version 2>/dev/null || echo 'installed'))"
else
  info "npm install -g @anthropic-ai/claude-code"
  npm install -g @anthropic-ai/claude-code
  ok "Claude Code installed"
fi

# =============================================================
#  Step 5: Gemini CLI (optional)
# =============================================================
step_header "Installing Gemini CLI..."

if $NO_GEMINI; then
  ok "Skipped (--no-gemini)"
else
  if command -v gemini &>/dev/null; then
    ok "Gemini CLI already installed"
  else
    info "npm install -g @anthropic-ai/gemini-cli"
    npm install -g @google/gemini-cli 2>/dev/null || {
      info "Gemini CLI install failed (non-fatal), skipping"
    }
    if command -v gemini &>/dev/null; then
      ok "Gemini CLI installed"
    else
      ok "Gemini CLI not available (optional)"
    fi
  fi
fi

# =============================================================
#  Step 6: Download Klaudii
# =============================================================
step_header "Downloading Klaudii..."

mkdir -p "$KLAUDII_DIR" "$LOGS_DIR" "$DATA_DIR"

if [ -d "$APP_DIR/.git" ]; then
  info "Updating existing installation..."
  cd "$APP_DIR"
  git pull --ff-only origin main 2>/dev/null || {
    info "git pull failed (non-fatal), keeping current version"
  }
else
  info "Cloning to $APP_DIR..."
  git clone "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

info "Installing Node dependencies..."
npm ci --production 2>/dev/null || npm install --production
ok "Klaudii installed at $APP_DIR"

# --- Config ---
CONFIG_FILE="$KLAUDII_DIR/config.json"
if [ ! -f "$CONFIG_FILE" ]; then
  # Find repos directory
  REPOS_DIR=""
  for candidate in "$HOME/repos" "$HOME/Projects" "$HOME/projects" "$HOME/src" "$HOME/code"; do
    if [ -d "$candidate" ]; then
      REPOS_DIR="$candidate"
      break
    fi
  done
  REPOS_DIR="${REPOS_DIR:-$HOME/repos}"

  TMUX_SOCKET="$KLAUDII_DIR/tmux.sock"

  cat > "$CONFIG_FILE" <<CONF
{
  "port": 9876,
  "ttydBasePort": 9877,
  "reposDir": "$REPOS_DIR",
  "tmuxSocket": "$TMUX_SOCKET",
  "projects": []
}
CONF
  ok "Config created at $CONFIG_FILE"
else
  ok "Config already exists"
fi

# --- .env template ---
ENV_FILE="$KLAUDII_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'ENV'
# Klaudii environment — set your API key here
# ANTHROPIC_API_KEY=sk-ant-...
ENV
  ok "Created $ENV_FILE (set your API key here)"
fi

# =============================================================
#  Step 7: systemd user service
# =============================================================
step_header "Setting up systemd service..."

mkdir -p "$SYSTEMD_DIR"

NODE_BIN=$(which node)

cat > "$SYSTEMD_DIR/klaudii.service" <<SERVICE
[Unit]
Description=Klaudii — AI Session Manager
After=network.target

[Service]
Type=simple
ExecStart=$NODE_BIN $APP_DIR/server.js
WorkingDirectory=$APP_DIR
Restart=on-failure
RestartSec=5

# Environment
Environment=HOME=$HOME
Environment=PATH=$BIN_DIR:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.npm-global/bin
EnvironmentFile=-$KLAUDII_DIR/.env

# Logging
StandardOutput=append:$LOGS_DIR/server.log
StandardError=append:$LOGS_DIR/server-error.log

[Install]
WantedBy=default.target
SERVICE

# Reload, enable, start
systemctl --user daemon-reload
systemctl --user enable klaudii.service
systemctl --user restart klaudii.service

# Enable lingering so service runs after logout
if command -v loginctl &>/dev/null; then
  loginctl enable-linger "$(whoami)" 2>/dev/null || true
fi

ok "systemd service enabled and started"

# =============================================================
#  Done!
# =============================================================
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  ${GREEN}${BOLD}Klaudii is running!${NC} → ${BOLD}http://localhost:9876${NC}"
echo ""
echo -e "  ${DIM}Next steps:${NC}"
echo -e "    1. Set your ANTHROPIC_API_KEY in ${BOLD}$ENV_FILE${NC}"
echo -e "    2. Open ${BOLD}http://localhost:9876${NC} in your browser"
echo -e "    3. Add your first project"
echo ""
echo -e "  ${DIM}Manage:${NC}"
echo -e "    systemctl --user status klaudii"
echo -e "    systemctl --user restart klaudii"
echo -e "    journalctl --user -u klaudii -f"
echo ""
echo -e "  ${DIM}Files:${NC}"
echo -e "    App:    $APP_DIR"
echo -e "    Config: $CONFIG_FILE"
echo -e "    Logs:   $LOGS_DIR/"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
