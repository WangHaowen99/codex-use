#!/usr/bin/env bash
# start-proxy.sh — start a chat-proxy for the given provider
# Usage: bash start-proxy.sh <provider>  (provider = deepseek | zhipu)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVIDER="${1:-}"

if [ -z "$PROVIDER" ]; then
    echo "Usage: start-proxy.sh <deepseek|zhipu>" >&2
    exit 1
fi

# Config
case "$PROVIDER" in
    deepseek)
        PORT=8788
        UPSTREAM="${DEEPSEEK_BASE_URL:-https://api.deepseek.com/v1}"
        ;;
    zhipu)
        PORT=8789
        UPSTREAM="${ZHIPU_BASE_URL:-https://open.bigmodel.cn/api/paas/v4}"
        ;;
    *)
        echo "Unknown provider: $PROVIDER" >&2
        exit 1
        ;;
esac

PID_FILE="${CODEX_HOME:-$HOME/codex-home}/tmp/${PROVIDER}-proxy.pid"
LOG_FILE="${CODEX_HOME:-$HOME/codex-home}/log/${PROVIDER}-proxy.log"

mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"

# Already running?
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "${PROVIDER}-proxy already running (pid $(cat "$PID_FILE"))"
    exit 0
fi

# Load API key from codex-providers.env
API_KEY=""
if [ -f "$HOME/.codex-providers.env" ]; then
    case "$PROVIDER" in
        deepseek)
            API_KEY="$(grep '^CODEX_DEEPSEEK_API_KEY=' "$HOME/.codex-providers.env" | sed "s/.*='\(.*\)'/\1/")"
            ;;
        zhipu)
            API_KEY="$(grep '^CODEX_ZHIPU_API_KEY=' "$HOME/.codex-providers.env" | sed "s/.*='\(.*\)'/\1/")"
            ;;
    esac
fi

# Fallback: also try claude-code-providers.env
if [ -z "$API_KEY" ] && [ -f "$HOME/.claude-code-providers.env" ]; then
    case "$PROVIDER" in
        deepseek)
            API_KEY="$(grep '^CLAUDE_CODE_DEEPSEEK_AUTH_TOKEN=' "$HOME/.claude-code-providers.env" | sed "s/.*='\(.*\)'/\1/")"
            ;;
    esac
fi

if [ -z "$API_KEY" ]; then
    echo "Cannot find API key for $PROVIDER. Check ~/.codex-providers.env" >&2
    exit 1
fi

nohup env PROXY_PORT="$PORT" \
         PROXY_UPSTREAM="$UPSTREAM" \
         PROXY_API_KEY="$API_KEY" \
         node "$SCRIPT_DIR/chat-proxy.mjs" >>"$LOG_FILE" 2>&1 &

echo $! >"$PID_FILE"
echo "${PROVIDER}-proxy started (pid $!, port $PORT, upstream $UPSTREAM)"
