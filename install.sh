#!/usr/bin/env bash
# ─── Dokalab OMC HUD — Installer ─────────────────────────────────────────────
# Installs or updates the Claude Code statusline HUD.
#
# Usage:
#   bash install.sh            (local clone)
#   curl -fsSL <url> | bash    (remote one-liner)
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Config ───────────────────────────────────────────────────────────────────
REQUIRED_NODE_MAJOR=18
HUD_FILE="dokalab_omc_hud.mjs"
HUD_DIR="$HOME/.claude/hud"
SETTINGS_FILE="$HOME/.claude/settings.json"
HUD_COMMAND="node \$HOME/.claude/hud/$HUD_FILE"

# ─── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()  { printf "${CYAN}[info]${RESET}  %s\n" "$*"; }
ok()    { printf "${GREEN}[ok]${RESET}    %s\n" "$*"; }
warn()  { printf "${YELLOW}[warn]${RESET}  %s\n" "$*"; }
fail()  { printf "${RED}[fail]${RESET}  %s\n" "$*"; exit 1; }

# ─── Step 1: Node.js version check ───────────────────────────────────────────
info "Checking Node.js..."

if ! command -v node &>/dev/null; then
    fail "Node.js not found. Install Node.js v${REQUIRED_NODE_MAJOR}+ first: https://nodejs.org"
fi

NODE_VERSION=$(node -v | sed 's/^v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)

if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
    fail "Node.js v${NODE_VERSION} is too old. Upgrade to v${REQUIRED_NODE_MAJOR}+: https://nodejs.org"
fi

ok "Node.js v${NODE_VERSION}"

# ─── Step 2: Locate HUD source file ──────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_FILE="$SCRIPT_DIR/$HUD_FILE"

if [ ! -f "$SOURCE_FILE" ]; then
    fail "Cannot find $HUD_FILE in $SCRIPT_DIR"
fi

# ─── Step 3: Copy HUD file ───────────────────────────────────────────────────
mkdir -p "$HUD_DIR"

if [ -f "$HUD_DIR/$HUD_FILE" ]; then
    # Compare checksums to detect actual changes
    OLD_HASH=$(md5sum "$HUD_DIR/$HUD_FILE" 2>/dev/null | cut -d' ' -f1 || true)
    NEW_HASH=$(md5sum "$SOURCE_FILE" | cut -d' ' -f1)

    if [ "$OLD_HASH" = "$NEW_HASH" ]; then
        ok "HUD already up to date"
    else
        cp "$SOURCE_FILE" "$HUD_DIR/$HUD_FILE"
        chmod +x "$HUD_DIR/$HUD_FILE"
        ok "HUD updated (overwritten with new version)"
    fi
else
    cp "$SOURCE_FILE" "$HUD_DIR/$HUD_FILE"
    chmod +x "$HUD_DIR/$HUD_FILE"
    ok "HUD installed to $HUD_DIR/$HUD_FILE"
fi

# ─── Step 4: Update settings.json ────────────────────────────────────────────
info "Configuring settings.json..."

mkdir -p "$(dirname "$SETTINGS_FILE")"

if [ ! -f "$SETTINGS_FILE" ]; then
    # No settings file — create fresh
    cat > "$SETTINGS_FILE" <<EOF
{
  "statusLine": {
    "type": "command",
    "command": "$HUD_COMMAND"
  }
}
EOF
    ok "Created $SETTINGS_FILE"
else
    # settings.json exists — check if statusLine already points to our HUD
    if command -v python3 &>/dev/null; then
        UPDATED=$(python3 -c "
import json, sys

with open('$SETTINGS_FILE', 'r') as f:
    settings = json.load(f)

sl = settings.get('statusLine', {})
cmd = sl.get('command', '')

# Already configured
if '$HUD_FILE' in cmd:
    print('ALREADY')
    sys.exit(0)

# Has a different statusLine — back it up before overwriting
if cmd:
    print('REPLACED')
else:
    print('ADDED')

settings['statusLine'] = {
    'type': 'command',
    'command': '$HUD_COMMAND'
}

with open('$SETTINGS_FILE', 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')
")

        case "$UPDATED" in
            ALREADY)
                ok "settings.json already configured" ;;
            REPLACED)
                warn "Replaced existing statusLine in settings.json"
                ok "settings.json updated" ;;
            ADDED)
                ok "statusLine added to settings.json" ;;
        esac
    else
        # No python3 — use simple grep check + manual instruction
        if grep -q "$HUD_FILE" "$SETTINGS_FILE" 2>/dev/null; then
            ok "settings.json already configured"
        else
            warn "Could not auto-update settings.json (python3 not available)"
            echo ""
            echo "  Add this to $SETTINGS_FILE manually:"
            echo ""
            echo "    \"statusLine\": {"
            echo "      \"type\": \"command\","
            echo "      \"command\": \"$HUD_COMMAND\""
            echo "    }"
            echo ""
        fi
    fi
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
printf "${BOLD}${GREEN}✓ Dokalab OMC HUD installed!${RESET}\n"
echo "  Restart Claude Code to activate."
echo ""
