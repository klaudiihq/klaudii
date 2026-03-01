#!/bin/bash
set -euo pipefail

# =========================================
#  Klaudii Installer
#  The Operating System for AI-Assisted Development
# =========================================

REPO="https://github.com/klaudii-dev/klaudii.git"
INSTALL_DIR="$HOME/.klaudii"
PURPLE='\033[0;35m'
GREEN='\033[0;32m'
DIM='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${PURPLE}${BOLD}  Klaudii Installer${NC}"
echo -e "${DIM}  The Operating System for AI-Assisted Development${NC}"
echo ""

# ---- Check dependencies ----
check_dep() {
  if command -v "$1" &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} $2 found"
    return 0
  else
    return 1
  fi
}

echo -e "${BOLD}Checking dependencies...${NC}"

if ! check_dep node "Node.js $(node --version 2>/dev/null || echo '')"; then
  echo "  ✗ Node.js 18+ is required. Install from https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  ✗ Node.js 18+ required (found $(node --version))"
  exit 1
fi

if ! check_dep brew "Homebrew"; then
  echo "  ✗ Homebrew is required. Install from https://brew.sh"
  exit 1
fi

if ! check_dep git "git"; then
  echo "  ✗ git is required"
  exit 1
fi

if ! check_dep gh "GitHub CLI (gh)"; then
  echo -e "  ${DIM}Installing GitHub CLI...${NC}"
  brew install gh
  check_dep gh "GitHub CLI (gh)"
fi

if ! check_dep claude "Claude Code CLI"; then
  echo "  ✗ Claude Code CLI is required. Install with: npm install -g @anthropic-ai/claude-code"
  exit 1
fi

echo ""

# ---- Install tmux and ttyd ----
echo -e "${BOLD}Installing system dependencies...${NC}"

if ! command -v tmux &>/dev/null; then
  echo -e "  ${DIM}Installing tmux...${NC}"
  brew install tmux
fi
check_dep tmux "tmux"

if ! command -v ttyd &>/dev/null; then
  echo -e "  ${DIM}Installing ttyd...${NC}"
  brew install ttyd
fi
check_dep ttyd "ttyd"

echo ""

# ---- Clone or update ----
echo -e "${BOLD}Setting up Klaudii...${NC}"

if [ -d "$INSTALL_DIR" ]; then
  echo -e "  ${DIM}Updating existing installation...${NC}"
  cd "$INSTALL_DIR"
  git pull --ff-only origin main 2>/dev/null || true
else
  echo -e "  ${DIM}Cloning Klaudii...${NC}"
  git clone "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# ---- Install Node dependencies ----
echo -e "  ${DIM}Installing dependencies...${NC}"
npm ci --production --silent 2>/dev/null || npm install --production --silent

echo -e "  ${GREEN}✓${NC} Klaudii installed at $INSTALL_DIR"
echo ""

# ---- Run the mac installer ----
echo -e "${BOLD}Configuring macOS integration...${NC}"

if [ -f "$INSTALL_DIR/mac/install.sh" ]; then
  bash "$INSTALL_DIR/mac/install.sh"
else
  echo -e "  ${DIM}Creating config...${NC}"
  cat > "$INSTALL_DIR/config.json" <<CONF
{
  "port": 9876,
  "ttydBasePort": 9877,
  "reposDir": "$HOME/repos",
  "tmuxSocket": "$HOME/.claude/klaudii-tmux.sock",
  "projects": []
}
CONF
  echo -e "  ${GREEN}✓${NC} Config created"

  # Start the server
  cd "$INSTALL_DIR"
  node server.js &
  SERVER_PID=$!
  sleep 2

  if kill -0 $SERVER_PID 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Server started (PID $SERVER_PID)"
  else
    echo "  ✗ Server failed to start. Check logs."
    exit 1
  fi
fi

echo ""
echo -e "${GREEN}${BOLD}  ✓ Klaudii is running at http://localhost:9876${NC}"
echo ""
echo -e "  ${DIM}Open your browser to get started.${NC}"
echo -e "  ${DIM}The server auto-starts on login via launchd.${NC}"
echo ""

# Open the dashboard
if command -v open &>/dev/null; then
  open "http://localhost:9876"
fi
