#!/bin/bash

# Read JSON input
input=$(cat)

# Extract Data from JSON
MODEL=$(echo "$input" | jq -r '.model.display_name // "Claude"')
CURRENT_DIR=$(echo "$input" | jq -r '.workspace.current_dir // "."')
COST=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')
PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | awk '{printf "%d", $1}')

# Change to current directory for git operations
cd "$CURRENT_DIR" 2>/dev/null || exit 1
DIR_NAME=$(basename "$CURRENT_DIR")

# Git branch and status
GIT_BRANCH=$(git -c core.useBuiltinFSMonitor=false rev-parse --abbrev-ref HEAD 2>/dev/null)
GIT_STATUS=""
[ -n "$GIT_BRANCH" ] && ! git -c core.useBuiltinFSMonitor=false diff-index --quiet HEAD -- 2>/dev/null && GIT_STATUS="*"

# Runtimes
NODE_VERSION=$(node -v 2>/dev/null)
PYTHON_VERSION=$(pyenv version-name 2>/dev/null | grep -v "system")

# Colors
CYAN='\033[36m'; YELLOW='\033[33m'; GREEN='\033[32m'; MAGENTA='\033[35m'
BLUE='\033[34m'; GRAY='\033[90m'; WHITE='\033[97m'; RESET='\033[0m'; BOLD='\033[1m'

# Separator (Unified to ASCII Pipe)
SEP="${GRAY}|${RESET}"

# Context Bar Logic
BAR_WIDTH=20
filled_tenths=$(( PCT * BAR_WIDTH * 10 / 100 ))
full_blocks=$(( filled_tenths / 10 ))
frac=$(( filled_tenths % 10 ))
if   [ $frac -ge 8 ]; then SUB="▉"; elif [ $frac -ge 6 ]; then SUB="▊"; elif [ $frac -ge 4 ]; then SUB="▌"; elif [ $frac -ge 2 ]; then SUB="▎"; else SUB=""; fi

C0='\033[38;5;51m'; C1='\033[38;5;82m'; C2='\033[38;5;220m'; C3='\033[38;5;196m'; CEMPTY='\033[38;5;237m'
BAR=""
for (( i=0; i<BAR_WIDTH; i++ )); do
  pos=$(( i * 100 / BAR_WIDTH ))
  if   [ $pos -lt 25 ]; then COL="$C0"; elif [ $pos -lt 50 ]; then COL="$C1"; elif [ $pos -lt 75 ]; then COL="$C2"; else COL="$C3"; fi
  if [ $i -lt $full_blocks ]; then BAR+="${COL}█"; elif [ $i -eq $full_blocks ] && [ -n "$SUB" ]; then BAR+="${COL}${SUB}"; else BAR+="${CEMPTY}░"; fi
done
BAR+="$RESET"

# PCT Color
if [ "$PCT" -ge 75 ]; then PCT_COL="$C3"; elif [ "$PCT" -ge 50 ]; then PCT_COL="$C2"; elif [ "$PCT" -ge 25 ]; then PCT_COL="$C1"; else PCT_COL="$C0"; fi

# Runtime Info String
RUNTIMES=""
[ -n "$NODE_VERSION" ] && RUNTIMES+="${GREEN} ${NODE_VERSION}${RESET} "
[ -n "$PYTHON_VERSION" ] && RUNTIMES+="${MAGENTA} ${PYTHON_VERSION}${RESET} "

# Line 1: Identity & Git
LINE1="${BOLD}${CYAN}󰚩 ${MODEL}${RESET} ${GRAY}❯${RESET} ${BLUE} ${DIR_NAME}${RESET}"
if [ -n "$GIT_BRANCH" ]; then
  LINE1+=" ${SEP} ${YELLOW} ${GIT_BRANCH}${GIT_STATUS}${RESET}"
fi

# Line 2: Stats & Runtimes (Updated Cost Icon to 󰡗 Cash Multiple)
LINE2="${GRAY}CTX${RESET} [${BAR}] ${BOLD}${PCT_COL}${PCT}%${RESET} ${SEP} ${RUNTIMES}${SEP} ${YELLOW}󰡗 \$$(printf '%.4f' "$COST")${RESET}"

echo -e "$LINE1"
echo -e "$LINE2"