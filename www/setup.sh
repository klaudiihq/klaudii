#!/bin/bash
set -euo pipefail

# =========================================
#  Klaudii Installer
#  The Operating System for AI-Assisted Development
#  curl -fsSL https://klaudii.com/setup.sh | bash
# =========================================

PURPLE='\033[0;35m'
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${PURPLE}${BOLD}  Klaudii Installer${NC}"
echo -e "${DIM}  The Operating System for AI-Assisted Development${NC}"
echo ""

OS="$(uname -s)"

# ════════════════════════════════════════
#  macOS
# ════════════════════════════════════════
if [ "$OS" = "Darwin" ]; then

  REPO="https://github.com/klaudiihq/klaudii.git"
  KLAUDII_DIR="$HOME/.klaudii"
  APP_DIR="$KLAUDII_DIR/app"
  LOGS_DIR="$KLAUDII_DIR/app/logs"
  ENV_FILE="$KLAUDII_DIR/.env"
  PORT=9876
  SERVICE_NAME="com.klaudii.server"

  ok()   { echo -e "      ${GREEN}✓${NC} $1"; }
  info() { echo -e "      → $1"; }
  fail() { echo -e "      ${RED}✗${NC} $1"; exit 1; }

  step_num=0
  total_steps=6
  step() {
    step_num=$((step_num + 1))
    echo ""
    echo -e "${BOLD}[$step_num/$total_steps] $1${NC}"
  }

  # Step 1: System tools via Homebrew
  step "Checking system dependencies..."

  if ! command -v brew &>/dev/null; then
    fail "Homebrew is required. Install from https://brew.sh"
  fi
  ok "Homebrew found"

  if ! command -v node &>/dev/null; then
    fail "Node.js 18+ is required. Install from https://nodejs.org"
  fi
  NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
  if [ "$NODE_MAJOR" -lt 18 ]; then
    fail "Node.js 18+ required (found $(node --version))"
  fi
  ok "Node.js $(node --version)"

  if ! command -v git &>/dev/null; then fail "git is required"; fi
  ok "git found"

  # Step 2: tmux + ttyd
  step "Installing tmux and ttyd..."

  if ! command -v tmux &>/dev/null; then
    info "brew install tmux"
    brew install tmux
  fi
  ok "tmux $(tmux -V | awk '{print $2}')"

  if ! command -v ttyd &>/dev/null; then
    info "brew install ttyd"
    brew install ttyd
  fi
  ok "ttyd found"

  # Step 3: GitHub CLI + Claude Code
  step "Installing GitHub CLI and Claude Code..."

  if ! command -v gh &>/dev/null; then
    info "brew install gh"
    brew install gh
  fi
  ok "gh $(gh --version | head -1 | awk '{print $3}')"

  if ! command -v claude &>/dev/null; then
    info "npm install -g @anthropic-ai/claude-code"
    npm install -g @anthropic-ai/claude-code
  fi
  ok "claude $(claude --version 2>/dev/null || echo 'found')"

  # Step 4: Download Klaudii
  step "Downloading Klaudii..."

  mkdir -p "$KLAUDII_DIR"

  if [ -d "$APP_DIR/.git" ]; then
    info "Updating existing installation..."
    cd "$APP_DIR"
    git pull --ff-only origin main 2>/dev/null || info "Could not fast-forward, keeping current version"
  else
    info "Cloning to $APP_DIR..."
    git clone "$REPO" "$APP_DIR"
    cd "$APP_DIR"
  fi

  info "Installing npm dependencies..."
  npm ci --production --silent 2>/dev/null || npm install --production --silent
  ok "Klaudii installed at $APP_DIR"

  # Step 5: Config + env
  step "Creating config..."

  CONFIG_FILE="$KLAUDII_DIR/config.json"
  if [ ! -f "$CONFIG_FILE" ]; then
    REPOS_DIR=""
    for candidate in "$HOME/repos" "$HOME/Projects" "$HOME/src" "$HOME/code"; do
      [ -d "$candidate" ] && REPOS_DIR="$candidate" && break
    done
    REPOS_DIR="${REPOS_DIR:-$KLAUDII_DIR/repos}"

    TMUX_BIN="$(command -v tmux 2>/dev/null || echo tmux)"
    TTYD_BIN="$(command -v ttyd 2>/dev/null || echo ttyd)"
    CLAUDE_BIN="$(command -v claude 2>/dev/null || echo "")"
    GEMINI_BIN="$(command -v gemini 2>/dev/null || echo "")"

    cat > "$CONFIG_FILE" <<CONF
{
  "port": $PORT,
  "ttydBasePort": 9877,
  "reposDir": "$REPOS_DIR",
  "tmuxSocket": "$KLAUDII_DIR/tmux.sock",
  "tmuxPath": "$TMUX_BIN",
  "ttydPath": "$TTYD_BIN",
  "claudePath": "$CLAUDE_BIN",
  "geminiPath": "$GEMINI_BIN",
  "dataDir": "$KLAUDII_DIR/data",
  "logsDir": "$KLAUDII_DIR/app/logs",
  "relayDir": "$KLAUDII_DIR/app/relay",
  "chatsDir": "$KLAUDII_DIR/data/chats",
  "projects": []
}
CONF
    ok "Config created at $CONFIG_FILE"
  else
    ok "Config already exists"
  fi

  if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" <<'ENVFILE'
# Klaudii environment
# ANTHROPIC_API_KEY=sk-ant-...
# GEMINI_API_KEY=...
ENVFILE
    ok "Created $ENV_FILE — add your API keys there"
  fi

  mkdir -p "$LOGS_DIR" "$KLAUDII_DIR/app/relay" "$KLAUDII_DIR/data" "$KLAUDII_DIR/repos"

  # Step 6: launchd service
  step "Setting up launchd service..."

  NODE_PATH="$(which node)"
  PLIST_PATH="$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"
  mkdir -p "$HOME/Library/LaunchAgents"

  cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${APP_DIR}/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${APP_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>KLAUDII_CONFIG</key>
    <string>${CONFIG_FILE}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOGS_DIR}/server.log</string>
  <key>StandardErrorPath</key>
  <string>${LOGS_DIR}/server-error.log</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
PLIST

  ok "Created $PLIST_PATH"

  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH"

  sleep 2
  if launchctl list "$SERVICE_NAME" &>/dev/null; then
    ok "Klaudii is running on port $PORT"
  else
    info "Service may not have started — check: tail -f $LOGS_DIR/server-error.log"
  fi

  echo ""
  echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}${BOLD}  Klaudii is ready! → http://localhost:$PORT${NC}"
  echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "  ${BOLD}Next steps:${NC}"
  echo -e "    1. Set your ANTHROPIC_API_KEY in ${DIM}$ENV_FILE${NC}"
  echo -e "    2. Open ${DIM}http://localhost:$PORT${NC} in your browser"
  echo -e "    3. Add your first project"
  echo ""
  echo -e "  ${BOLD}Manage:${NC}"
  echo -e "    ${DIM}launchctl list $SERVICE_NAME${NC}"
  echo -e "    ${DIM}launchctl kickstart -k gui/\$(id -u)/$SERVICE_NAME${NC}"
  echo -e "    ${DIM}tail -f $LOGS_DIR/server.log${NC}"
  echo ""

  open "http://localhost:$PORT"

# ════════════════════════════════════════
#  Linux
# ════════════════════════════════════════
elif [ "$OS" = "Linux" ]; then

  REPO="https://github.com/klaudiihq/klaudii.git"
  KLAUDII_DIR="$HOME/.klaudii"
  APP_DIR="$KLAUDII_DIR/app"
  BIN_DIR="$KLAUDII_DIR/bin"
  LOGS_DIR="$KLAUDII_DIR/app/logs"
  ENV_FILE="$KLAUDII_DIR/.env"
  SYSTEMD_DIR="$HOME/.config/systemd/user"
  SERVICE_NAME="klaudii"
  PORT=9876
  NO_GEMINI=false
  NODE_MAJOR_REQUIRED=18

  for arg in "$@"; do
    case "$arg" in
      --no-gemini) NO_GEMINI=true ;;
    esac
  done

  step_num=0
  total_steps=7
  $NO_GEMINI && total_steps=6

  step() {
    step_num=$((step_num + 1))
    echo ""
    echo -e "${BOLD}[$step_num/$total_steps] $1${NC}"
  }

  ok()   { echo -e "      ${GREEN}✓${NC} $1"; }
  info() { echo -e "      → $1"; }
  fail() { echo -e "      ${RED}✗${NC} $1"; exit 1; }

  # Detect distro + package manager
  PKG_MGR=""
  DISTRO_NAME="Linux"
  if command -v apt-get &>/dev/null; then
    PKG_MGR="apt"
    [ -f /etc/os-release ] && DISTRO_NAME="$(. /etc/os-release && echo "${PRETTY_NAME:-Linux (apt)}")"
  elif command -v dnf &>/dev/null; then
    PKG_MGR="dnf"
    [ -f /etc/os-release ] && DISTRO_NAME="$(. /etc/os-release && echo "${PRETTY_NAME:-Linux (dnf)}")"
  elif command -v yum &>/dev/null; then
    PKG_MGR="yum"
    DISTRO_NAME="Linux (yum)"
  elif command -v pacman &>/dev/null; then
    PKG_MGR="pacman"
    DISTRO_NAME="Linux (pacman)"
  else
    echo -e "  ${RED}✗${NC} No supported package manager found (need apt, dnf, yum, or pacman)"
    exit 1
  fi

  echo -e "  ${DIM}Detected: $DISTRO_NAME ($PKG_MGR)${NC}"

  wait_for_apt() {
    if ! sudo fuser /var/lib/dpkg/lock-frontend &>/dev/null; then return 0; fi
    local elapsed=0
    printf "      → Waiting for apt lock (auto-updater running)... (%ds)" "$elapsed"
    while sudo fuser /var/lib/dpkg/lock-frontend &>/dev/null; do
      sleep 1
      elapsed=$((elapsed+1))
      printf "\r      → Waiting for apt lock (auto-updater running)... (%ds)" "$elapsed"
    done
    printf "\r      → apt lock released after %ds%s\n" "$elapsed" "$(printf '%*s' 20 '')"
  }

  pkg_install() {
    case "$PKG_MGR" in
      apt)    wait_for_apt && sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" ;;
      dnf)    sudo dnf install -y -q "$@" ;;
      yum)    sudo yum install -y -q "$@" ;;
      pacman) sudo pacman -S --noconfirm --needed "$@" ;;
    esac
  }

  # Step 1: System packages
  step "Installing system packages (tmux, git, gh, build tools)..."

  PKGS_TO_INSTALL=()

  if ! command -v tmux &>/dev/null; then
    PKGS_TO_INSTALL+=(tmux)
  else
    ok "tmux already installed"
  fi

  if ! command -v git &>/dev/null; then
    PKGS_TO_INSTALL+=(git)
  else
    ok "git already installed"
  fi

  case "$PKG_MGR" in
    apt)    PKGS_TO_INSTALL+=(build-essential python3) ;;
    dnf)    PKGS_TO_INSTALL+=(gcc gcc-c++ make python3) ;;
    yum)    PKGS_TO_INSTALL+=(gcc gcc-c++ make python3) ;;
    pacman) PKGS_TO_INSTALL+=(base-devel python) ;;
  esac

  if [ ${#PKGS_TO_INSTALL[@]} -gt 0 ]; then
    info "sudo required for $PKG_MGR install"
    pkg_install "${PKGS_TO_INSTALL[@]}"
    ok "System packages installed"
  fi

  if ! command -v gh &>/dev/null; then
    info "Installing GitHub CLI (gh)..."
    case "$PKG_MGR" in
      apt)
        sudo mkdir -p -m 755 /etc/apt/keyrings
        curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
        sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli-stable.list >/dev/null
        wait_for_apt && sudo apt-get update -qq && sudo apt-get install -y -qq gh
        ;;
      dnf|yum)
        sudo dnf install -y -q 'dnf-command(config-manager)' 2>/dev/null || true
        sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo 2>/dev/null || true
        sudo dnf install -y -q gh 2>/dev/null || sudo yum install -y -q gh
        ;;
      pacman)
        sudo pacman -S --noconfirm --needed github-cli
        ;;
    esac
    ok "GitHub CLI installed"
  else
    ok "gh already installed"
  fi

  # Step 2: Node.js
  step "Installing Node.js $NODE_MAJOR_REQUIRED+..."

  install_node() {
    info "Installing Node.js via NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y -qq nodejs 2>/dev/null || sudo dnf install -y -q nodejs 2>/dev/null || sudo yum install -y -q nodejs 2>/dev/null
  }

  if command -v node &>/dev/null; then
    NODE_VER=$(node -e "console.log(process.versions.node.split('.')[0])")
    if [ "$NODE_VER" -ge "$NODE_MAJOR_REQUIRED" ]; then
      ok "Node.js $(node --version) already installed"
    else
      info "Node.js $(node --version) is too old (need $NODE_MAJOR_REQUIRED+)"
      install_node
      ok "Node.js $(node --version) installed"
    fi
  else
    install_node
    ok "Node.js $(node --version) installed"
  fi

  if ! command -v npm &>/dev/null; then
    fail "npm not found after Node.js install — something went wrong"
  fi

  # Step 3: ttyd
  step "Installing ttyd..."

  mkdir -p "$BIN_DIR"

  if command -v ttyd &>/dev/null; then
    ok "ttyd already installed ($(which ttyd))"
  elif [ -x "$BIN_DIR/ttyd" ]; then
    ok "ttyd already installed ($BIN_DIR/ttyd)"
  else
    ARCH=$(uname -m)
    case "$ARCH" in
      x86_64)  TTYD_ARCH="x86_64" ;;
      aarch64) TTYD_ARCH="aarch64" ;;
      armv7l)  TTYD_ARCH="armhf" ;;
      *)       fail "Unsupported architecture for ttyd: $ARCH" ;;
    esac

    TTYD_URL="https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.${TTYD_ARCH}"
    info "Downloading ttyd for $TTYD_ARCH to $BIN_DIR/ttyd"
    curl -fsSL "$TTYD_URL" -o "$BIN_DIR/ttyd"
    chmod +x "$BIN_DIR/ttyd"
    ok "ttyd installed to $BIN_DIR/ttyd"
  fi

  # Step 4: Claude Code CLI
  step "Installing Claude Code CLI..."

  if command -v claude &>/dev/null; then
    CLAUDE_VER=$(claude --version 2>/dev/null || echo "unknown")
    ok "Claude Code already installed ($CLAUDE_VER)"
  else
    info "npm install -g @anthropic-ai/claude-code"
    sudo npm install -g @anthropic-ai/claude-code
    ok "Claude Code installed"
  fi

  # Step 5: Gemini CLI (optional)
  if ! $NO_GEMINI; then
    step "Installing Gemini CLI..."

    if command -v gemini &>/dev/null; then
      ok "Gemini CLI already installed"
    else
      info "npm install -g @google/gemini-cli"
      sudo npm install -g @google/gemini-cli 2>/dev/null || {
        info "Gemini CLI install failed (non-fatal, skipping)"
      }
      if command -v gemini &>/dev/null; then
        ok "Gemini CLI installed"
      else
        info "Gemini CLI not available — you can install it later"
      fi
    fi
  fi

  # Step 6: Download Klaudii
  step "Downloading Klaudii..."

  mkdir -p "$KLAUDII_DIR"

  if [ -d "$APP_DIR/.git" ]; then
    info "Updating existing installation..."
    cd "$APP_DIR"
    git pull --ff-only origin main 2>/dev/null || info "Could not fast-forward, keeping current version"
  else
    info "Cloning to $APP_DIR..."
    git clone "$REPO" "$APP_DIR"
    cd "$APP_DIR"
  fi

  info "Installing npm dependencies..."
  npm ci --production 2>/dev/null || npm install --production
  ok "Klaudii installed at $APP_DIR"

  CONFIG_FILE="$KLAUDII_DIR/config.json"
  if [ ! -f "$CONFIG_FILE" ]; then
    REPOS_DIR=""
    for candidate in "$HOME/repos" "$HOME/Projects" "$HOME/src" "$HOME/code"; do
      if [ -d "$candidate" ]; then
        REPOS_DIR="$candidate"
        break
      fi
    done
    REPOS_DIR="${REPOS_DIR:-$KLAUDII_DIR/repos}"

    TMUX_BIN="$(command -v tmux 2>/dev/null || echo tmux)"
    TTYD_BIN="$(command -v ttyd 2>/dev/null || echo ttyd)"
    CLAUDE_BIN="$(command -v claude 2>/dev/null || echo "")"
    GEMINI_BIN="$(command -v gemini 2>/dev/null || echo "")"

    cat > "$CONFIG_FILE" <<CONF
{
  "port": $PORT,
  "ttydBasePort": 9877,
  "reposDir": "$REPOS_DIR",
  "tmuxSocket": "$KLAUDII_DIR/tmux.sock",
  "tmuxPath": "$TMUX_BIN",
  "ttydPath": "$TTYD_BIN",
  "claudePath": "$CLAUDE_BIN",
  "geminiPath": "$GEMINI_BIN",
  "dataDir": "$KLAUDII_DIR/data",
  "logsDir": "$KLAUDII_DIR/app/logs",
  "relayDir": "$KLAUDII_DIR/app/relay",
  "chatsDir": "$KLAUDII_DIR/data/chats",
  "projects": []
}
CONF
    ok "Config created at $CONFIG_FILE"
  fi

  if [ ! -e "$APP_DIR/config.json" ] && [ -f "$CONFIG_FILE" ]; then
    ln -sf "$CONFIG_FILE" "$APP_DIR/config.json"
    ok "Linked config.json into app directory"
  fi

  if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" <<'ENVFILE'
# Klaudii environment — loaded by systemd
# Set your API keys here:
# ANTHROPIC_API_KEY=sk-ant-...
# GEMINI_API_KEY=...
ENVFILE
    ok "Created $ENV_FILE — add your API keys there"
  fi

  mkdir -p "$LOGS_DIR" "$KLAUDII_DIR/app/relay" "$KLAUDII_DIR/data" "$KLAUDII_DIR/repos"

  # Step 7: systemd user service
  step "Setting up systemd service..."

  NODE_PATH="$(which node)"
  EXTRA_PATH="$BIN_DIR"

  mkdir -p "$SYSTEMD_DIR"

  cat > "$SYSTEMD_DIR/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=Klaudii — AI Session Manager
After=network.target

[Service]
Type=simple
ExecStart=$NODE_PATH $APP_DIR/server.js
WorkingDirectory=$APP_DIR
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=KLAUDII_CONFIG=$CONFIG_FILE
Environment=PATH=$EXTRA_PATH:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-$ENV_FILE
StandardOutput=append:$LOGS_DIR/server.log
StandardError=append:$LOGS_DIR/server-error.log

[Install]
WantedBy=default.target
UNIT

  ok "Created $SYSTEMD_DIR/${SERVICE_NAME}.service"

  if command -v loginctl &>/dev/null; then
    sudo loginctl enable-linger "$(whoami)" 2>/dev/null || info "Could not enable-linger — service will only run while logged in"
  fi

  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME"
  systemctl --user start "$SERVICE_NAME" 2>/dev/null || systemctl --user restart "$SERVICE_NAME"

  sleep 2
  if systemctl --user is-active "$SERVICE_NAME" &>/dev/null; then
    ok "Klaudii is running on port $PORT"
  else
    info "Service may not have started — check: journalctl --user -u $SERVICE_NAME"
  fi

  echo ""
  echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}${BOLD}  Klaudii is ready! → http://localhost:$PORT${NC}"
  echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "  ${BOLD}Next steps:${NC}"
  echo -e "    1. Set your ANTHROPIC_API_KEY in ${DIM}$ENV_FILE${NC}"
  echo -e "    2. Open ${DIM}http://localhost:$PORT${NC} in your browser"
  echo -e "    3. Add your first project"
  echo ""
  echo -e "  ${BOLD}Manage:${NC}"
  echo -e "    ${DIM}systemctl --user status $SERVICE_NAME${NC}"
  echo -e "    ${DIM}systemctl --user restart $SERVICE_NAME${NC}"
  echo -e "    ${DIM}journalctl --user -u $SERVICE_NAME -f${NC}"
  echo ""

else
  echo -e "  ${RED}✗${NC} Unsupported platform: $OS. Klaudii supports macOS and Linux."
  exit 1
fi
